// Windows worker ownership. This host joins its own job before starting the runtime, so even the first child
// inherits membership. Only the server holds its control pipe. No process is selected by name or command line.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NexusWorkerJob
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AllocConsole();
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int show);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool SetStdHandle(int kind, IntPtr handle);

    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTime, PerJobUserTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    static IntPtr job;
    static Process runtime;
    static readonly int self = Process.GetCurrentProcess().Id;
    static readonly object output = new object(), cleanup = new object();
    static string Encode(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value)); }
    static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
    static void Send(string value) { lock (output) { Console.Out.WriteLine(value); Console.Out.Flush(); } }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    static List<uint> Members() {
        for (int capacity = 64; capacity <= 1048576; capacity *= 2) {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                if (!QueryInformationJobObject(job, 3, data, (uint)size, IntPtr.Zero)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 234) continue; // ERROR_MORE_DATA: membership grew.
                    throw new Win32Exception(error);
                }
                var result = new List<uint>();
                int count = Marshal.ReadInt32(data, 4);
                for (int i = 0; i < count; i++) result.Add((uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                return result;
            } finally { Marshal.FreeHGlobal(data); }
        }
        throw new InvalidOperationException("worker job membership exceeded the limit");
    }

    // A PID is only a way to open a handle. Check membership on that same handle before terminating it: Windows
    // can reuse the enumerated PID before OpenProcess. Holding the handle pins the identity through termination.
    static void End(uint pid) {
        IntPtr handle = OpenProcess(0x100000 | 0x1000 | 1, false, pid); // synchronize, query limited, terminate
        if (handle == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 87) return; // already gone
            throw new Win32Exception(error);
        }
        try {
            bool member;
            Check(IsProcessInJob(handle, job, out member));
            if (!member) return;
            if (WaitForSingleObject(handle, 0) == 0) return;
            if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0) Check(false);
            if (WaitForSingleObject(handle, 2000) != 0) throw new TimeoutException("worker child did not exit");
        } finally { CloseHandle(handle); }
    }

    static void Clean(bool keepRuntime) {
        lock (cleanup) {
            var timer = Stopwatch.StartNew();
            while (true) {
                var targets = Members().FindAll(pid => pid != self && (!keepRuntime || pid != runtime.Id));
                if (targets.Count == 0) return;
                foreach (uint pid in targets) End(pid);
                if (timer.ElapsedMilliseconds > 10000) throw new TimeoutException("worker job did not settle");
            }
        }
    }

    static Thread Pump(StreamReader reader, string prefix) {
        var thread = new Thread(() => {
            try { string line; while ((line = reader.ReadLine()) != null) Send(prefix + Encode(line + "\n")); }
            catch (IOException) { } // the job is closing
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    // Keep the console outside the job, then join before any runtime can inherit ownership.
    static void CreateWorkerJob() {
        // Give the runtime a console whose lifetime belongs to this host, before any job membership. Preserve
        // the server's redirected pipes across allocation. No shared console or user process is a cleanup target.
        IntPtr input = GetStdHandle(-10), outputHandle = GetStdHandle(-11), errorHandle = GetStdHandle(-12);
        FreeConsole();
        Check(AllocConsole());
        ShowWindow(GetConsoleWindow(), 0);
        SetStdHandle(-10, input); SetStdHandle(-11, outputHandle); SetStdHandle(-12, errorHandle);
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway
        int size = Marshal.SizeOf(limits);
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, data, false);
            Check(SetInformationJobObject(job, 9, data, (uint)size));
        } finally { Marshal.FreeHGlobal(data); }
        // The job handle is non-inheritable. Closing the host (even a crash) therefore kills the whole job.
        Check(AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle));
    }

    public static void Run() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        // The first two lines are the executable and its already Windows-quoted argument string.
        string executable = Decode(Console.ReadLine());
        string arguments = Decode(Console.ReadLine());
        CreateWorkerJob();
        runtime = Process.Start(new ProcessStartInfo(executable, arguments) {
            // Share the host's private hidden console, created before job assignment. Creating a console inside
            // the job would make its conhost a cleanup target and break the runtime's next child (0xc0000142).
            UseShellExecute = false, CreateNoWindow = false,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        });
        Send("R " + runtime.Id);
        Thread stdout = Pump(runtime.StandardOutput, "O "), stderr = Pump(runtime.StandardError, "E ");
        // Runtime input can block (a hung CLI stopped reading). Keep it off the control reader, so a server EOF
        // or a kill still closes the job, even while a large prompt is waiting for the runtime to consume it.
        var writes = new BlockingCollection<string>();
        var writer = new Thread(() => {
            foreach (string write in writes.GetConsumingEnumerable()) {
                try {
                    if (write == "E") runtime.StandardInput.Close();
                    else { runtime.StandardInput.Write(Decode(write.Substring(2))); runtime.StandardInput.Flush(); }
                } catch (IOException) { } // runtime exit is reported by the monitor
                catch (ObjectDisposedException) { }
            }
        });
        writer.IsBackground = true;
        writer.Start();
        var monitor = new Thread(() => {
            try {
                runtime.WaitForExit();
                Clean(false);
                stdout.Join(2000); stderr.Join(2000);
                Send("X " + runtime.ExitCode);
                Environment.Exit(0);
            } catch (Exception e) { Send("F " + Encode(e.Message)); Environment.Exit(1); }
        });
        monitor.IsBackground = true;
        monitor.Start();
        string command;
        while ((command = Console.ReadLine()) != null) {
            if (command.StartsWith("W ") || command == "E") writes.Add(command);
            else if (command == "K") Clean(false);
            else if (command.StartsWith("C ")) {
                try { Clean(true); Send(command); }
                catch (Exception e) { Send("F " + Encode(e.Message)); }
            } else throw new InvalidOperationException("unknown worker control command");
        }
        // The server's pipe closed: do not depend on it being able to send a final kill command.
        Clean(false);
        Environment.Exit(0);
    }
}
