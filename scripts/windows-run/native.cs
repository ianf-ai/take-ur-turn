// Native Windows ownership. No Context Hub writes; all handles stay inside the broker.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class TutRunNative {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,width,height,xChars,yChars,fill,flags;
        public short show,reservedSize; public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Child {
        public IntPtr process,thread; public uint pid,tid;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Security {
        public int length; public IntPtr descriptor; public int inherit;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out Child pi);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern IntPtr CreateFileW(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr buffer,uint size,out uint returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint kind,uint group);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetConsoleProcessList([Out] uint[] processes,uint count);

    static void Fail(string op) { throw new Win32Exception(Marshal.GetLastWin32Error(),op); }
    // Microsoft CRT argv quoting; no cmd.exe/PowerShell source interpolation.
    public static string Quote(string value) {
        if(value==null || value.IndexOf('\0')>=0) throw new ArgumentException("NUL/null argv");
        StringBuilder b=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); }
            else { b.Append('\\',slashes); b.Append(c); }
            slashes=0;
        }
        b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
    }
    public static StringBuilder Command(string exe,string[] args) {
        StringBuilder b=new StringBuilder(Quote(exe));
        foreach(string arg in args) b.Append(" ").Append(Quote(arg));
        return b;
    }
    public static Child Broker(string exe,string[] args,string cwd) {
        Startup s=new Startup(); s.cb=Marshal.SizeOf(s); s.flags=1; s.show=0;
        Child c;
        // Console belongs to broker. NEW_PROCESS_GROUP is deliberately absent.
        if(!CreateProcessW(exe,Command(exe,args),IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,cwd,ref s,out c)) Fail("broker CreateProcessW");
        return c;
    }
    public static IntPtr Job() {
        IntPtr job=CreateJobObjectW(IntPtr.Zero,null);
        if(job==IntPtr.Zero) Fail("CreateJobObjectW");
        // No KILL_ON_JOB_CLOSE or BREAKAWAY flags; helper failure is observable.
        return job;
    }
    [StructLayout(LayoutKind.Sequential)] public struct ExtendedStartup { public Startup startup; public IntPtr attributes; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateProcessW")]
    static extern bool CreateExtended(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref ExtendedStartup si,out Child pi);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    static IntPtr File(string name,bool write) {
        Security sec=new Security(); sec.length=Marshal.SizeOf(sec); sec.inherit=1;
        // Append-only output; share read/write, not deletion. NUL is the only input.
        IntPtr h=CreateFileW(name,write?4u:0x80000000u,3,ref sec,3,0x80,IntPtr.Zero);
        if(h==new IntPtr(-1)) Fail("CreateFileW"); return h;
    }
    public static Child Suspended(string exe,string[] args,string cwd,string log,string environment) {
        IntPtr input=IntPtr.Zero,output=IntPtr.Zero,list=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero;
        bool initialized=false;
        try {
            input=File("NUL",false); output=File(log,true);
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            list=Marshal.AllocHGlobal(size);
            if(!InitializeProcThreadAttributeList(list,1,0,ref size)) Fail("InitializeProcThreadAttributeList"); initialized=true;
            handles=Marshal.AllocHGlobal(2*IntPtr.Size); Marshal.WriteIntPtr(handles,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output);
            if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(2*IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) Fail("HANDLE_LIST");
            ExtendedStartup s=new ExtendedStartup(); s.startup.cb=Marshal.SizeOf(s); s.startup.flags=0x100;
            s.startup.input=input; s.startup.output=output; s.startup.error=output; s.attributes=list;
            env=Marshal.StringToHGlobalUni(environment); Child c;
            // EXTENDED_STARTUPINFO_PRESENT | UNICODE_ENVIRONMENT | NEW_PROCESS_GROUP | SUSPENDED.
            if(!CreateExtended(exe,Command(exe,args),IntPtr.Zero,IntPtr.Zero,true,0x80604,env,cwd,ref s,out c)) Fail("target CreateProcessW");
            return c;
        } finally {
            if(initialized) DeleteProcThreadAttributeList(list);
            if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
            if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
            if(input!=IntPtr.Zero) CloseHandle(input);
            if(output!=IntPtr.Zero) CloseHandle(output);
        }
    }
    public static void Assign(IntPtr job,IntPtr process) { if(!AssignProcessToJobObject(job,process)) Fail("AssignProcessToJobObject"); }
    public static void Resume(IntPtr thread) { if(ResumeThread(thread)==0xffffffff) Fail("ResumeThread"); }
    public static long Created(IntPtr process) {
        long created,exited,kernel,user;
        if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) Fail("GetProcessTimes"); return created;
    }
    public static bool Alive(IntPtr process) {
        uint status=WaitForSingleObject(process,0);
        if(status==0) return false; if(status==258) return true;
        Fail("WaitForSingleObject"); return false;
    }
    public static uint ExitCode(IntPtr process) { uint code; if(!GetExitCodeProcess(process,out code)) Fail("GetExitCodeProcess"); return code; }
    public static uint[] ConsoleMembers() {
        uint[] p=new uint[4096]; uint n=GetConsoleProcessList(p,(uint)p.Length);
        if(n==0) Fail("GetConsoleProcessList");
        if(n>p.Length) throw new Exception("console process list exceeded bound");
        Array.Resize(ref p,(int)n); return p;
    }
    public static uint[] Members(IntPtr job) {
        int size=8+4096*IntPtr.Size; IntPtr p=Marshal.AllocHGlobal(size);
        try {
            uint returned;
            if(!QueryInformationJobObject(job,3,p,(uint)size,out returned)) Fail("QueryInformationJobObject");
            int assigned=Marshal.ReadInt32(p),count=Marshal.ReadInt32(p,4);
            if(count<0 || count>4096 || count!=assigned) throw new Exception("job membership incomplete");
            uint[] ids=new uint[count];
            for(int i=0;i<count;i++) ids[i]=checked((uint)Marshal.ReadIntPtr(p,8+i*IntPtr.Size).ToInt64());
            return ids;
        } finally { Marshal.FreeHGlobal(p); }
    }
    // Caller holds each handle through taskkill and rechecks native liveness.
    public static IntPtr Owned(IntPtr job,uint pid) {
        IntPtr h=OpenProcess(0x101000,false,pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
        if(h==IntPtr.Zero) Fail("OpenProcess member");
        try {
            bool member;
            if(!IsProcessInJob(h,job,out member)) Fail("IsProcessInJob");
            if(!member || !Alive(h)) throw new Exception("member identity/liveness changed");
            Created(h); return h;
        } catch { CloseHandle(h); throw; }
    }
    public static void Break(uint group) {
        if(group==0) throw new ArgumentException("broadcast is forbidden");
        if(!GenerateConsoleCtrlEvent(1,group)) Fail("GenerateConsoleCtrlEvent");
    }

    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern IntPtr CreateNamedPipeW(string name,uint mode,uint type,uint max,uint output,uint input,uint timeout,ref Security security);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    public static System.IO.Pipes.NamedPipeServerStream Pipe(string name) {
        string sid=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        IntPtr sd;uint size;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;"+sid+")",1,out sd,out size)) Fail("pipe ACL");
        try {
            Security security=new Security(); security.length=Marshal.SizeOf(security);security.descriptor=sd;
            // Duplex, overlapped, first instance; byte mode; reject remote clients.
            IntPtr h=CreateNamedPipeW(@"\\.\pipe\"+name,0x40080003,8,1,65536,65536,0,ref security);
            if(h==new IntPtr(-1)) Fail("CreateNamedPipeW");
            return new System.IO.Pipes.NamedPipeServerStream(System.IO.Pipes.PipeDirection.InOut,true,false,new Microsoft.Win32.SafeHandles.SafePipeHandle(h,true));
        } finally { LocalFree(sd); }
    }
    public static string ReadFrame(System.IO.Stream stream) {
        using(var memory=new System.IO.MemoryStream()) {
            for(int n=0;n<1048576;n++) { int b=stream.ReadByte(); if(b<0) { if(n==0)return null;throw new Exception("truncated frame"); }
                if(b==10)return new UTF8Encoding(false,true).GetString(memory.ToArray()); memory.WriteByte((byte)b); }
            throw new Exception("oversized frame");
        }
    }
    public static void WriteFrame(System.IO.Stream stream,string value) {
        byte[] bytes=new UTF8Encoding(false,true).GetBytes(value+"\n");
        if(bytes.Length>1048576)throw new Exception("oversized response");stream.Write(bytes,0,bytes.Length);stream.Flush();
    }
    public static int Taskkill(uint pid,bool force,int timeout) {
        var start=new ProcessStartInfo(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"taskkill.exe"),"/PID "+pid+" /T"+(force?" /F":""));
        start.UseShellExecute=false;start.CreateNoWindow=true;start.RedirectStandardOutput=true;start.RedirectStandardError=true;
        using(var p=Process.Start(start)) {
            // Drain concurrently: taskkill output is diagnostic only, never completion evidence.
            var stdout=p.StandardOutput.ReadToEndAsync();var stderr=p.StandardError.ReadToEndAsync();
            var clock=Stopwatch.StartNew();
            if(!p.WaitForExit(timeout))throw new Exception("delivery-uncertain: taskkill deadline exceeded");
            int remaining=Math.Max(0,timeout-(int)clock.ElapsedMilliseconds);
            if(!System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[]{stdout,stderr},remaining))throw new Exception("delivery-uncertain: taskkill output deadline exceeded");
            return p.ExitCode;
        }
    }
}
