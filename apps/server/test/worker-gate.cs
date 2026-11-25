// Test-only, compiled with apps/server/src/worker-job.cs into the gate host (worker-gate.ps1), never by the real host.
// It wraps the host's own native seam (NexusWorkerJob.calls, WHR1) so that a real job host, with its real job and its
// real processes, holds its cleanup inside End: at AwaitExit's 2000 ms wait, on the handle End opened and checked for
// one target process the test names. Every other call, and the held wait itself once opened, is the real one.
//
// The gate's folder (a test's temporary directory) is its whole interface:
//   target    the PID to hold (written by the test once its helper is up); read at each OpenProcess
//   refuse    when present, the target's first TerminateProcess is not made: it returns false with error 5, as the
//             Codex trace did (WH2); the target lives on until the test lets it end by itself
//   arrived   written by the gate when End waits at it: "<pid> <handle> member" (the handle End checked)
//   holdopen  N: End holds before its Nth OpenProcess of any member as well ("<pid> 0 open")
//   open      written by the test: the held wait (or open) goes on, as the real call
//             The gate's first hold answers in "arrived" and goes on at "open", its kth (k > 1, queue WHR, WHR6) in
//             "arrived-k" and at "open-k": a wait and a later open can be held in one cleanup.
//   crash     written by the test while End is held at the wait: the host ends its runtime through its own Process
//             object (a runtime crash during the cleanup), then writes "crashed" ("<pid> <exit code>") and holds on
//   calls.log every native call End made for the target, one line each
//   trace.log every membership list Clean read and every native call End made, for any member (WHR6)
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;

public sealed class GatedEndCalls : NexusWorkerJob.EndCalls {
    readonly NexusWorkerJob.EndCalls real;
    readonly string dir;
    readonly Dictionary<long, uint> opened = new Dictionary<long, uint>();
    readonly object guard = new object();
    bool refused, held;
    int opens, holds;
    int injectedError;
    [ThreadStatic] static bool injected;
    // A failed call's own error, read at once: the gate's file writes after it would replace the thread's last error
    // before End reads it (LastError below gives this one).
    [ThreadStatic] static bool saved;
    [ThreadStatic] static int savedError;
    void Save(bool failed) { saved = failed; if (failed) savedError = real.LastError(); }

    internal GatedEndCalls(NexusWorkerJob.EndCalls real, string dir) { this.real = real; this.dir = dir; }

    uint Target() {
        string file = Path.Combine(dir, "target");
        uint pid;
        return File.Exists(file) && uint.TryParse(File.ReadAllText(file).Trim(), out pid) ? pid : 0;
    }
    bool IsTarget(IntPtr handle) { lock (guard) return opened.ContainsKey(handle.ToInt64()); }
    // Written whole, then renamed: the test never reads a file the gate is still writing.
    void Arrive(string name, string text) {
        string temp = Path.Combine(dir, name + ".tmp");
        File.WriteAllText(temp, text);
        File.Move(temp, Path.Combine(dir, name));
    }
    // The gate's next hold: answered in its own file, gone on from at its own (see above). `waiting` runs while held.
    void Hold(string text, Action waiting) {
        int k;
        lock (guard) k = ++holds;
        Arrive(k == 1 ? "arrived" : "arrived-" + k, text);
        string open = Path.Combine(dir, k == 1 ? "open" : "open-" + k);
        while (!File.Exists(open)) { if (waiting != null) waiting(); Thread.Sleep(10); }
    }
    void Log(string line) { lock (guard) File.AppendAllText(Path.Combine(dir, "calls.log"), line + "\n"); }
    void Trace(string line) { lock (guard) File.AppendAllText(Path.Combine(dir, "trace.log"), line + "\n"); }

    public List<uint> Members() {
        List<uint> members = real.Members();
        Trace("Members " + string.Join(" ", members.ConvertAll(x => x.ToString()).ToArray()));
        return members;
    }
    public object StartTimer() { return real.StartTimer(); }
    public long ElapsedMilliseconds(object timer) { return real.ElapsedMilliseconds(timer); }

    // Holds before the Nth OpenProcess End makes for any member (the file "holdopen" names N), before the open itself:
    // for a target End cannot open (a DACL denial), whose cleanup fails at the open and never reaches the wait, this
    // holds the next cleanup (the kill's) before it ends anything.
    void HoldOpen(uint pid) {
        string file = Path.Combine(dir, "holdopen");
        int n, count;
        lock (guard) count = ++opens;
        if (!File.Exists(file) || !int.TryParse(File.ReadAllText(file).Trim(), out n) || n != count) return;
        Log("held open " + pid);
        Trace("held open " + pid);
        Hold(pid + " 0 open", null);
    }

    public IntPtr OpenProcess(uint access, bool inherit, uint pid) {
        if (pid != 0) HoldOpen(pid);
        IntPtr handle = real.OpenProcess(access, inherit, pid);
        Save(handle == IntPtr.Zero);
        Trace("OpenProcess " + pid + " " + handle.ToInt64() + (saved ? " error " + savedError : ""));
        if (pid != 0 && pid == Target()) {
            lock (guard) if (handle != IntPtr.Zero) opened[handle.ToInt64()] = pid;
            Log("OpenProcess " + pid + " " + handle.ToInt64());
        }
        return handle;
    }
    // The host's runtime, by the Process object the host started it with (never by a PID): killed and waited for.
    void CrashRuntime() {
        var runtime = (System.Diagnostics.Process)typeof(NexusWorkerJob).GetField("runtime", BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
        runtime.Kill();
        runtime.WaitForExit();
        Log("runtime killed " + runtime.Id);
        string temp = Path.Combine(dir, "crashed.tmp");
        File.WriteAllText(temp, runtime.Id + " " + runtime.ExitCode);
        File.Move(temp, Path.Combine(dir, "crashed"));
    }
    public bool IsProcessInJob(IntPtr process, IntPtr job, out bool member) {
        bool ok = real.IsProcessInJob(process, job, out member);
        Save(!ok);
        Trace("IsProcessInJob " + process.ToInt64() + " " + ok + " " + member);
        if (IsTarget(process)) Log("IsProcessInJob " + process.ToInt64() + " " + ok + " " + member);
        return ok;
    }
    public uint WaitForSingleObject(IntPtr handle, uint ms) {
        if (IsTarget(handle) && ms == 2000) {
            bool first;
            lock (guard) { first = !held; held = true; }
            if (first) {
                Log("held " + handle.ToInt64());
                string crash = Path.Combine(dir, "crash");
                bool crashed = false;
                Hold(Target() + " " + handle.ToInt64() + " member", () => { if (!crashed && File.Exists(crash)) { crashed = true; CrashRuntime(); } });
            }
        }
        uint result = real.WaitForSingleObject(handle, ms);
        Trace("WaitForSingleObject " + handle.ToInt64() + " " + ms + " " + result);
        if (IsTarget(handle)) Log("WaitForSingleObject " + handle.ToInt64() + " " + ms + " " + result);
        return result;
    }
    public bool TerminateProcess(IntPtr process, uint code) {
        if (IsTarget(process)) {
            bool refuse;
            lock (guard) { refuse = !refused && File.Exists(Path.Combine(dir, "refuse")); if (refuse) refused = true; }
            if (refuse) {
                Log("TerminateProcess " + process.ToInt64() + " injected false 5");
                injected = true; injectedError = 5;
                return false;
            }
            bool ok = real.TerminateProcess(process, code);
            Save(!ok);
            injected = false;
            Log("TerminateProcess " + process.ToInt64() + " " + ok);
            Trace("TerminateProcess " + process.ToInt64() + " " + ok + (saved ? " error " + savedError : ""));
            return ok;
        }
        injected = false;
        bool done = real.TerminateProcess(process, code);
        Save(!done);
        Trace("TerminateProcess " + process.ToInt64() + " " + done + (saved ? " error " + savedError : ""));
        return done;
    }
    public bool CloseHandle(IntPtr handle) {
        bool target;
        lock (guard) { target = opened.Remove(handle.ToInt64()); }
        if (target) Log("CloseHandle " + handle.ToInt64());
        Trace("CloseHandle " + handle.ToInt64());
        return real.CloseHandle(handle);
    }
    public int LastError() {
        // End reads the error right after the call it belongs to: the injected one after an injected refusal.
        if (injected) { injected = false; return injectedError; }
        if (saved) { saved = false; return savedError; }
        return real.LastError();
    }
}

public static class GateHost {
    public static void Install(string dir) {
        FieldInfo calls = typeof(NexusWorkerJob).GetField("calls", BindingFlags.NonPublic | BindingFlags.Static);
        calls.SetValue(null, new GatedEndCalls((NexusWorkerJob.EndCalls)calls.GetValue(null), dir));
    }
}
