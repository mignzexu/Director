using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentPlatform.Runtime
{
    public static class NativeLauncher
    {
        private const int ErrorAlreadyExists = 183;
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint CreateNoWindow = 0x08000000;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint StartfUseStdHandles = 0x00000100;
        private const uint JobObjectInfoClassExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const uint Infinite = 0xffffffff;
        private const uint WaitTimeout = 0x00000102;
        private const ulong ProcThreadAttributeSecurityCapabilities = 0x00020009;
        private const uint GenericWrite = 0x40000000;
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint CreateAlways = 0x00000002;
        private const uint FileAttributeNormal = 0x00000080;

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityCapabilities
        {
            public IntPtr AppContainerSid;
            public IntPtr Capabilities;
            public uint CapabilityCount;
            public uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SidAndAttributes
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        private const uint SE_GROUP_ENABLED = 0x00000004;
        private const string InternetClientCapabilitySid = "S-1-15-3-1";

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfo
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateAppContainerProfile", SetLastError = true)]
        private static extern int CreateAppContainerProfile(
            string name,
            string displayName,
            string description,
            IntPtr capabilities,
            uint capabilityCount,
            out IntPtr appContainerSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, EntryPoint = "DeriveAppContainerSidFromAppContainerName", SetLastError = true)]
        private static extern int DeriveAppContainerSidFromAppContainerName(
            string name,
            out IntPtr appContainerSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, EntryPoint = "DeleteAppContainerProfile", SetLastError = true)]
        private static extern int DeleteAppContainerProfile(string name);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "ConvertStringSidToSidW", SetLastError = true)]
        private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "ConvertSidToStringSidW", SetLastError = true)]
        private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

        [DllImport("kernel32.dll", EntryPoint = "LocalFree", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("advapi32.dll", EntryPoint = "FreeSid", SetLastError = true)]
        private static extern IntPtr FreeSid(IntPtr sid);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            uint attributeCount,
            uint flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW", SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateJobObjectW", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            uint informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength);

        private const uint JobObjectCpuRateControlInfoClass = 20;
        private const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
        private const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
        private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x200;

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectCpuRateControlInformation
        {
            public uint CpuRate;
            public uint ControlFlags;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObjectCpuRate(
            IntPtr job,
            uint informationClass,
            ref JobObjectCpuRateControlInformation information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateFileW", SetLastError = true)]
        private static extern IntPtr CreateFile(
            string name,
            uint desiredAccess,
            uint shareMode,
            ref SecurityAttributes securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        public static string CreateProfile(string name)
        {
            IntPtr sid = IntPtr.Zero;
            int result = CreateAppContainerProfile(
                name,
                "Agent Platform Sandbox",
                "Project-owned OpenCode execution sandbox",
                IntPtr.Zero,
                0,
                out sid);

            if (result != 0)
            {
                if ((result & 0xffff) != ErrorAlreadyExists)
                {
                    throw HResultError("CreateAppContainerProfile", result);
                }

                result = DeriveAppContainerSidFromAppContainerName(name, out sid);
                if (result != 0)
                {
                    throw HResultError("DeriveAppContainerSidFromAppContainerName", result);
                }
            }

            if (sid == IntPtr.Zero)
            {
                throw new InvalidOperationException("Windows returned an empty AppContainer SID");
            }

            try
            {
                return SidToString(sid);
            }
            finally
            {
                FreeSid(sid);
            }
        }

        public static void DeleteProfile(string name)
        {
            int result = DeleteAppContainerProfile(name);
            if (result != 0 && (result & 0xffff) != 2)
            {
                throw HResultError("DeleteAppContainerProfile", result);
            }
        }

        public static int Run(
            string profileName,
            string executable,
            string commandFile,
            string stdoutFile,
            string stderrFile,
            string currentDirectory,
            string[] environment,
            uint timeoutMilliseconds,
            bool networkCapability,
            uint memoryLimitMb,
            uint cpuRatePercent)
        {
            IntPtr sid = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr securityCapabilitiesMemory = IntPtr.Zero;
            IntPtr environmentMemory = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            IntPtr stdinHandle = IntPtr.Zero;
            IntPtr stdoutHandle = IntPtr.Zero;
            IntPtr stderrHandle = IntPtr.Zero;
            IntPtr capabilityList = IntPtr.Zero;
            IntPtr capabilitySid = IntPtr.Zero;
            ProcessInformation processInformation = new ProcessInformation();
            bool processCreated = false;

            try
            {
                if (DeriveAppContainerSidFromAppContainerName(profileName, out sid) != 0)
                {
                    ThrowLastError("DeriveAppContainerSidFromAppContainerName");
                }

                SecurityCapabilities securityCapabilities = new SecurityCapabilities();
                securityCapabilities.AppContainerSid = sid;
                securityCapabilities.Capabilities = IntPtr.Zero;
                securityCapabilities.CapabilityCount = 0;
                securityCapabilities.Reserved = 0;

                if (networkCapability)
                {
                    // S-1-15-3-1 = internetClient: the minimal capability that
                    // lets an AppContainer make outbound connections.
                    if (!ConvertStringSidToSid(InternetClientCapabilitySid, out capabilitySid))
                    {
                        ThrowLastError("ConvertStringSidToSid(internetClient)");
                    }
                    SidAndAttributes[] capabilities = new SidAndAttributes[1];
                    capabilities[0].Sid = capabilitySid;
                    capabilities[0].Attributes = SE_GROUP_ENABLED;
                    capabilityList = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidAndAttributes)) * capabilities.Length);
                    Marshal.StructureToPtr(capabilities[0], capabilityList, false);
                    securityCapabilities.Capabilities = capabilityList;
                    securityCapabilities.CapabilityCount = 1;
                }

                securityCapabilitiesMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
                Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesMemory, false);

                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                if (attributeSize == IntPtr.Zero)
                {
                    ThrowLastError("InitializeProcThreadAttributeList(size)");
                }
                attributeList = Marshal.AllocHGlobal(attributeSize.ToInt32());
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
                {
                    ThrowLastError("InitializeProcThreadAttributeList");
                }
                if (!UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    new IntPtr(unchecked((long)ProcThreadAttributeSecurityCapabilities)),
                    securityCapabilitiesMemory,
                    new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    ThrowLastError("UpdateProcThreadAttribute(SecurityCapabilities)");
                }

                JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    ThrowLastError("CreateJobObject");
                }
                if (!SetInformationJobObject(
                    job,
                    JobObjectInfoClassExtendedLimitInformation,
                    ref limits,
                    (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
                {
                    ThrowLastError("SetInformationJobObject");
                }

                if (memoryLimitMb > 0)
                {
                    limits.ProcessMemoryLimit = (UIntPtr)((ulong)memoryLimitMb * 1024UL * 1024UL);
                    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                    if (!SetInformationJobObject(
                        job,
                        JobObjectInfoClassExtendedLimitInformation,
                        ref limits,
                        (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
                    {
                        ThrowLastError("SetInformationJobObject(memory)");
                    }
                }

                if (cpuRatePercent > 0 && cpuRatePercent <= 100)
                {
                    JobObjectCpuRateControlInformation cpu = new JobObjectCpuRateControlInformation();
                    cpu.CpuRate = cpuRatePercent * 100;
                    cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
                    if (!SetInformationJobObjectCpuRate(
                        job,
                        JobObjectCpuRateControlInfoClass,
                        ref cpu,
                        (uint)Marshal.SizeOf(typeof(JobObjectCpuRateControlInformation))))
                    {
                        ThrowLastError("SetInformationJobObjectCpuRate");
                    }
                }

                SecurityAttributes inheritable = new SecurityAttributes();
                inheritable.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
                inheritable.lpSecurityDescriptor = IntPtr.Zero;
                inheritable.bInheritHandle = true;
                stdoutHandle = CreateFile(
                    stdoutFile,
                    GenericWrite,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    CreateAlways,
                    FileAttributeNormal,
                    IntPtr.Zero);
                if (stdoutHandle == new IntPtr(-1))
                {
                    ThrowLastError("CreateFile(stdout)");
                }
                stderrHandle = CreateFile(
                    stderrFile,
                    GenericWrite,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    CreateAlways,
                    FileAttributeNormal,
                    IntPtr.Zero);
                if (stderrHandle == new IntPtr(-1))
                {
                    ThrowLastError("CreateFile(stderr)");
                }
                stdinHandle = CreateFile(
                    "NUL",
                    GenericRead,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    3,
                    FileAttributeNormal,
                    IntPtr.Zero);
                if (stdinHandle == new IntPtr(-1))
                {
                    ThrowLastError("CreateFile(NUL)");
                }

                environmentMemory = BuildEnvironmentBlock(environment);
                string commandLineText = Quote(executable) + " /d /s /c call " + Quote(commandFile);
                StringBuilder commandLine = new StringBuilder(commandLineText);
                StartupInfoEx startupInfo = new StartupInfoEx();
                startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
                startupInfo.lpAttributeList = attributeList;
                startupInfo.StartupInfo.dwFlags = StartfUseStdHandles;
                startupInfo.StartupInfo.hStdInput = stdinHandle;
                startupInfo.StartupInfo.hStdOutput = stdoutHandle;
                startupInfo.StartupInfo.hStdError = stderrHandle;
                uint creationFlags = ExtendedStartupInfoPresent |
                    CreateSuspended |
                    CreateUnicodeEnvironment |
                    CreateNoWindow;

                if (!CreateProcess(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    creationFlags,
                    environmentMemory,
                    currentDirectory,
                    ref startupInfo,
                    out processInformation))
                {
                    int acError = Marshal.GetLastWin32Error();
                    if (acError == 203)
                    {
                        throw new Win32Exception(
                            acError,
                            "CreateProcess(AppContainer) failed: the sandbox environment is missing LOCALAPPDATA, which Windows needs to locate the AppContainer profile");
                    }
                    throw new Win32Exception(acError, "CreateProcess(AppContainer) failed (Win32 error " + acError + ")");
                }
                processCreated = true;

                if (!AssignProcessToJobObject(job, processInformation.hProcess))
                {
                    ThrowLastError("AssignProcessToJobObject");
                }
                if (ResumeThread(processInformation.hThread) == 0xffffffff)
                {
                    ThrowLastError("ResumeThread");
                }
                uint waitTimeout = timeoutMilliseconds == 0 ? Infinite : timeoutMilliseconds;
                uint wait = WaitForSingleObject(processInformation.hProcess, waitTimeout);
                if (wait == 0xffffffff)
                {
                    ThrowLastError("WaitForSingleObject");
                }
                if (wait == WaitTimeout)
                {
                    TerminateJobObject(job, 124);
                    WaitForSingleObject(processInformation.hProcess, Infinite);
                    return 124;
                }

                uint exitCode;
                if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
                {
                    ThrowLastError("GetExitCodeProcess");
                }
                return unchecked((int)exitCode);
            }
            catch
            {
                if (processCreated && job != IntPtr.Zero)
                {
                    TerminateJobObject(job, 1);
                }
                throw;
            }
            finally
            {
                if (processInformation.hThread != IntPtr.Zero)
                {
                    CloseHandle(processInformation.hThread);
                }
                if (processInformation.hProcess != IntPtr.Zero)
                {
                    CloseHandle(processInformation.hProcess);
                }
                if (job != IntPtr.Zero)
                {
                    CloseHandle(job);
                }
                if (stdinHandle != IntPtr.Zero && stdinHandle != new IntPtr(-1))
                {
                    CloseHandle(stdinHandle);
                }
                if (stdoutHandle != IntPtr.Zero && stdoutHandle != new IntPtr(-1))
                {
                    CloseHandle(stdoutHandle);
                }
                if (stderrHandle != IntPtr.Zero && stderrHandle != new IntPtr(-1))
                {
                    CloseHandle(stderrHandle);
                }
                if (attributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (securityCapabilitiesMemory != IntPtr.Zero)
                {
                    Marshal.DestroyStructure(securityCapabilitiesMemory, typeof(SecurityCapabilities));
                    Marshal.FreeHGlobal(securityCapabilitiesMemory);
                }
                if (capabilityList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(capabilityList);
                }
                if (capabilitySid != IntPtr.Zero)
                {
                    LocalFree(capabilitySid);
                }
                if (environmentMemory != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environmentMemory);
                }
                if (sid != IntPtr.Zero)
                {
                    FreeSid(sid);
                }
            }
        }

        /// <summary>
        /// Launch a containerized process WITHOUT waiting for it: the process
        /// tree intentionally outlives the launcher (background execution).
        /// stdout/stderr are redirected to the given files; the caller kills
        /// the tree later via `taskkill /T /F /PID`. Returns the root pid.
        /// NOTE: no Job Object — the tree must survive launcher death, so
        /// KillOnJobClose containment cannot apply here.
        /// </summary>
        public static uint StartDetached(
            string profileName,
            string executable,
            string commandFile,
            string stdoutFile,
            string stderrFile,
            string currentDirectory,
            string[] environment)
        {
            IntPtr sid = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr securityCapabilitiesMemory = IntPtr.Zero;
            IntPtr environmentMemory = IntPtr.Zero;
            IntPtr stdinHandle = IntPtr.Zero;
            IntPtr stdoutHandle = IntPtr.Zero;
            IntPtr stderrHandle = IntPtr.Zero;
            ProcessInformation processInformation = new ProcessInformation();

            try
            {
                if (DeriveAppContainerSidFromAppContainerName(profileName, out sid) != 0)
                {
                    ThrowLastError("DeriveAppContainerSidFromAppContainerName");
                }

                SecurityCapabilities securityCapabilities = new SecurityCapabilities();
                securityCapabilities.AppContainerSid = sid;
                securityCapabilities.Capabilities = IntPtr.Zero;
                securityCapabilities.CapabilityCount = 0;
                securityCapabilities.Reserved = 0;
                securityCapabilitiesMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
                Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesMemory, false);

                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                if (attributeSize == IntPtr.Zero)
                {
                    ThrowLastError("InitializeProcThreadAttributeList(size)");
                }
                attributeList = Marshal.AllocHGlobal(attributeSize.ToInt32());
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
                {
                    ThrowLastError("InitializeProcThreadAttributeList");
                }
                if (!UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    new IntPtr(unchecked((long)ProcThreadAttributeSecurityCapabilities)),
                    securityCapabilitiesMemory,
                    new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    ThrowLastError("UpdateProcThreadAttribute(SecurityCapabilities)");
                }

                SecurityAttributes inheritable = new SecurityAttributes();
                inheritable.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
                inheritable.lpSecurityDescriptor = IntPtr.Zero;
                inheritable.bInheritHandle = true;
                stdoutHandle = CreateFile(
                    stdoutFile,
                    GenericWrite,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    CreateAlways,
                    FileAttributeNormal,
                    IntPtr.Zero);
                if (stdoutHandle == new IntPtr(-1))
                {
                    ThrowLastError("CreateFile(stdout)");
                }
                stderrHandle = CreateFile(
                    stderrFile,
                    GenericWrite,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    CreateAlways,
                    FileAttributeNormal,
                    IntPtr.Zero);
                if (stderrHandle == new IntPtr(-1))
                {
                    ThrowLastError("CreateFile(stderr)");
                }
                stdinHandle = CreateFile(
                    "NUL",
                    GenericRead,
                    FileShareRead | FileShareWrite,
                    ref inheritable,
                    3,
                    FileAttributeNormal,
                    IntPtr.Zero);
                if (stdinHandle == new IntPtr(-1))
                {
                    ThrowLastError("CreateFile(NUL)");
                }

                environmentMemory = BuildEnvironmentBlock(environment);
                string commandLineText = Quote(executable) + " /d /s /c call " + Quote(commandFile);
                StringBuilder commandLine = new StringBuilder(commandLineText);
                StartupInfoEx startupInfo = new StartupInfoEx();
                startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
                startupInfo.lpAttributeList = attributeList;
                startupInfo.StartupInfo.dwFlags = StartfUseStdHandles;
                startupInfo.StartupInfo.hStdInput = stdinHandle;
                startupInfo.StartupInfo.hStdOutput = stdoutHandle;
                startupInfo.StartupInfo.hStdError = stderrHandle;
                uint creationFlags = ExtendedStartupInfoPresent |
                    CreateUnicodeEnvironment |
                    CreateNoWindow;

                if (!CreateProcess(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    creationFlags,
                    environmentMemory,
                    currentDirectory,
                    ref startupInfo,
                    out processInformation))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess(detached AppContainer) failed");
                }

                uint pid = processInformation.dwProcessId;
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
                CloseHandle(stdinHandle);
                CloseHandle(stdoutHandle);
                CloseHandle(stderrHandle);
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
                Marshal.FreeHGlobal(environmentMemory);
                Marshal.FreeHGlobal(securityCapabilitiesMemory);
                FreeSid(sid);
                return pid;
            }
            catch
            {
                if (processInformation.hThread != IntPtr.Zero && processInformation.hThread != new IntPtr(-1))
                {
                    CloseHandle(processInformation.hThread);
                }
                if (processInformation.hProcess != IntPtr.Zero && processInformation.hProcess != new IntPtr(-1))
                {
                    CloseHandle(processInformation.hProcess);
                }
                if (stdinHandle != IntPtr.Zero && stdinHandle != new IntPtr(-1))
                {
                    CloseHandle(stdinHandle);
                }
                if (stdoutHandle != IntPtr.Zero && stdoutHandle != new IntPtr(-1))
                {
                    CloseHandle(stdoutHandle);
                }
                if (stderrHandle != IntPtr.Zero && stderrHandle != new IntPtr(-1))
                {
                    CloseHandle(stderrHandle);
                }
                if (attributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (securityCapabilitiesMemory != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(securityCapabilitiesMemory);
                }
                if (environmentMemory != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environmentMemory);
                }
                if (sid != IntPtr.Zero)
                {
                    FreeSid(sid);
                }
                throw;
            }
        }

        public static string DeriveSidString(string profileName)
        {
            IntPtr sid = IntPtr.Zero;
            int result = DeriveAppContainerSidFromAppContainerName(profileName, out sid);
            if (result != 0)
            {
                throw HResultError("DeriveAppContainerSidFromAppContainerName", result);
            }
            try
            {
                return SidToString(sid);
            }
            finally
            {
                FreeSid(sid);
            }
        }

        private static string SidToString(IntPtr sid)
        {
            IntPtr stringSid;
            if (!ConvertSidToStringSid(sid, out stringSid))
            {
                ThrowLastError("ConvertSidToStringSid");
            }
            try
            {
                return Marshal.PtrToStringUni(stringSid);
            }
            finally
            {
                LocalFree(stringSid);
            }
        }

        private static IntPtr BuildEnvironmentBlock(string[] entries)
        {
            List<string> sorted = new List<string>(entries ?? new string[0]);
            sorted.Sort(StringComparer.OrdinalIgnoreCase);
            string block = string.Join("\0", sorted.ToArray()) + "\0\0";
            return Marshal.StringToHGlobalUni(block);
        }

        private static string Quote(string value)
        {
            if (value == null || value.IndexOf('"') >= 0)
            {
                throw new ArgumentException("sandbox paths cannot contain quotes");
            }
            return "\"" + value + "\"";
        }

        private static Exception HResultError(string operation, int result)
        {
            return new Win32Exception(result, operation + " failed (HRESULT 0x" + result.ToString("x8") + ")");
        }

        private static void ThrowLastError(string operation)
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, operation + " failed (Win32 error " + error + ")");
        }
    }
}
