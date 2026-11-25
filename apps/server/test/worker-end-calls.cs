// Test-only, compiled together with apps/server/src/worker-job.cs into one assembly (worker-end.ps1), never by the
// job host. It drives the production End through its native seam (NexusWorkerJob.EndCalls): a scripted seam records
// every call and returns the results the test gives; with no seam set, End runs on the kernel32 calls against real
// processes in a job this harness creates. The algorithm under test is End itself, reached by reflection.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// One scripted reply per call, in order, per operation: "open <handle> <error>", "member <ok> <member> <error>",
// "wait <result> <error>", "terminate <ok> <error>", "close <ok>". Each call sets the emulated last error to its
// reply's error (close and an omitted error leave it as it was), as a SetLastError call sets the thread's.
public sealed class ScriptedEndCalls : NexusWorkerJob.EndCalls {
    readonly Dictionary<string, Queue<long[]>> replies = new Dictionary<string, Queue<long[]>>();
    public readonly List<string> Log = new List<string>();
    int lastError;

    public void Reply(string op, long[] values) {
        Queue<long[]> queue;
        if (!replies.TryGetValue(op, out queue)) replies[op] = queue = new Queue<long[]>();
        queue.Enqueue(values);
    }

    long[] Next(string op) {
        Queue<long[]> queue;
        if (!replies.TryGetValue(op, out queue) || queue.Count == 0) throw new InvalidOperationException("no scripted reply for " + op);
        return queue.Dequeue();
    }

    void Error(long[] reply, int at) { if (reply.Length > at) lastError = (int)reply[at]; }

    public IntPtr OpenProcess(uint access, bool inherit, uint pid) {
        Log.Add("OpenProcess 0x" + access.ToString("x") + " " + inherit + " " + pid);
        long[] reply = Next("open"); Error(reply, 1);
        return new IntPtr(reply[0]);
    }
    public bool IsProcessInJob(IntPtr process, IntPtr job, out bool member) {
        Log.Add("IsProcessInJob " + process.ToInt64() + " " + job.ToInt64());
        long[] reply = Next("member"); Error(reply, 2);
        member = reply[1] != 0;
        return reply[0] != 0;
    }
    public uint WaitForSingleObject(IntPtr handle, uint ms) {
        Log.Add("WaitForSingleObject " + handle.ToInt64() + " " + ms);
        long[] reply = Next("wait"); Error(reply, 1);
        return unchecked((uint)reply[0]);
    }
    public bool TerminateProcess(IntPtr process, uint code) {
        Log.Add("TerminateProcess " + process.ToInt64() + " " + code);
        long[] reply = Next("terminate"); Error(reply, 1);
        return reply[0] != 0;
    }
    public bool CloseHandle(IntPtr handle) {
        Log.Add("CloseHandle " + handle.ToInt64());
        long[] reply = Next("close");
        return reply[0] != 0;
    }
    public int LastError() {
        Log.Add("LastError " + lastError);
        return lastError;
    }
}

public static class EndHarness {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Static;
    static readonly FieldInfo Calls = typeof(NexusWorkerJob).GetField("calls", Private);
    static readonly FieldInfo Job = typeof(NexusWorkerJob).GetField("job", Private);
    static readonly MethodInfo End = typeof(NexusWorkerJob).GetMethod("End", Private);

    // Requests separated by a line "---"; each answered by its block of lines, separated the same way.
    //   scripted <pid> <job>, then reply lines: End(pid) on the scripted seam, with the job field set to <job>.
    //   real <member> <stranger>: End on the default seam for a process this harness puts into a new job, for one it
    //   leaves outside, and for PID 0 (no process).
    public static string Run(string text) {
        var blocks = new List<string>();
        foreach (string request in text.Replace("\r", "").Split(new[] { "\n---\n" }, StringSplitOptions.None)) {
            string[] lines = request.Trim().Split('\n');
            string[] head = lines[0].Trim().Split(' ');
            if (head[0] == "scripted") blocks.Add(Scripted(uint.Parse(head[1]), long.Parse(head[2]), lines));
            else if (head[0] == "real") blocks.Add(Real(uint.Parse(head[1]), uint.Parse(head[2])));
            else throw new ArgumentException("unknown request: " + lines[0]);
        }
        return string.Join("\n---\n", blocks.ToArray()) + "\n";
    }

    static string Scripted(uint pid, long job, string[] lines) {
        var seam = new ScriptedEndCalls();
        for (int i = 1; i < lines.Length; i++) {
            string line = lines[i].Trim();
            if (line.Length == 0) continue;
            string[] parts = line.Split(' ');
            var values = new long[parts.Length - 1];
            for (int j = 1; j < parts.Length; j++) values[j - 1] = long.Parse(parts[j]);
            seam.Reply(parts[0], values);
        }
        object before = Calls.GetValue(null), beforeJob = Job.GetValue(null);
        string outcome;
        Calls.SetValue(null, seam); Job.SetValue(null, new IntPtr(job));
        try { outcome = Invoke(pid); }
        finally { Calls.SetValue(null, before); Job.SetValue(null, beforeJob); }
        var output = new StringBuilder();
        foreach (string call in seam.Log) output.Append(call).Append('\n');
        output.Append("outcome ").Append(outcome).Append('\n');
        output.Append("restored ").Append(Calls.GetValue(null).GetType().FullName);
        return output.ToString();
    }

    static string Real(uint member, uint stranger) {
        var output = new StringBuilder();
        output.Append("seam ").Append(Calls.GetValue(null).GetType().FullName).Append('\n');
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        object beforeJob = Job.GetValue(null);
        try {
            IntPtr process = OpenProcess(0x0100 | 0x0001, false, member); // set quota, terminate: what assigning needs
            if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            finally { CloseHandle(process); }
            Job.SetValue(null, job);
            output.Append("stranger ").Append(Invoke(stranger)).Append('\n');
            output.Append("none ").Append(Invoke(0)).Append('\n');
            output.Append("member ").Append(Invoke(member));
        } finally { Job.SetValue(null, beforeJob); CloseHandle(job); }
        return output.ToString();
    }

    static string Invoke(uint pid) {
        try { End.Invoke(null, new object[] { pid }); return "returned"; }
        catch (TargetInvocationException e) {
            Exception inner = e.InnerException;
            var win32 = inner as Win32Exception;
            return "threw " + inner.GetType().FullName + " " + (win32 != null ? win32.NativeErrorCode.ToString() : "-") + " " + inner.Message.Replace("\r", " ").Replace("\n", " ");
        }
    }
}
