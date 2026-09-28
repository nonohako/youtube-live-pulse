using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Xml.Linq;

namespace LivePulse.Windows;

// Windows starts Run entries one by one after login (7.5 minutes late on 2026-09-28 with
// about 15 login programs). A per-user logon task starts at once and needs no administrator
// rights. The Run entry stays as a fallback; the single-instance mutex ignores the second start.
internal static class LoginTask
{
    internal const string TaskName = "라이브 펄스";
    private static readonly XNamespace Ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
    private const int CreateOrUpdate = 6;
    private const int LogonInteractiveToken = 3;
    private const int FileNotFound = unchecked((int)0x80070002);

    internal static void Apply(bool enabled, string executable)
    {
        var serviceType = Type.GetTypeFromProgID("Schedule.Service") ?? throw new IOException("작업 스케줄러를 사용할 수 없습니다.");
        dynamic service = Activator.CreateInstance(serviceType)!;
        try
        {
            service.Connect();
            dynamic folder = service.GetFolder(@"\");
            string? xml = null;
            try { xml = folder.GetTask(TaskName).Xml; }
            // The runtime maps the missing-task HRESULT to FileNotFoundException, not COMException.
            catch (Exception error) when (error.HResult == FileNotFound) { }
            var current = xml is null ? null : ReadCommand(xml);
            // Never replace or remove an unrelated task that happens to use the product name.
            if (xml is not null && (current is null || !PrototypeApp.IsOwnRunCommand(current))) return;
            if (!enabled)
            {
                if (xml is not null) folder.DeleteTask(TaskName, 0);
                return;
            }
            if (string.Equals(current, PrototypeApp.RunCommand(executable), StringComparison.OrdinalIgnoreCase)) return;
            folder.RegisterTask(TaskName, BuildXml(executable, WindowsIdentity.GetCurrent().Name),
                CreateOrUpdate, null, null, LogonInteractiveToken, null);
        }
        finally { Marshal.FinalReleaseComObject(service); }
    }

    internal static string BuildXml(string executable, string user) => new XDocument(
        new XElement(Ns + "Task", new XAttribute("version", "1.2"),
            new XElement(Ns + "RegistrationInfo",
                new XElement(Ns + "Description", "Windows 로그인 직후 라이브 펄스를 트레이에서 시작합니다.")),
            new XElement(Ns + "Triggers",
                new XElement(Ns + "LogonTrigger", new XElement(Ns + "Enabled", "true"), new XElement(Ns + "UserId", user))),
            new XElement(Ns + "Principals",
                new XElement(Ns + "Principal", new XAttribute("id", "Author"),
                    new XElement(Ns + "UserId", user),
                    new XElement(Ns + "LogonType", "InteractiveToken"),
                    new XElement(Ns + "RunLevel", "LeastPrivilege"))),
            // Task defaults would stop the tray app after 72 hours or on battery and run it below normal priority.
            new XElement(Ns + "Settings",
                new XElement(Ns + "MultipleInstancesPolicy", "IgnoreNew"),
                new XElement(Ns + "DisallowStartIfOnBatteries", "false"),
                new XElement(Ns + "StopIfGoingOnBatteries", "false"),
                new XElement(Ns + "ExecutionTimeLimit", "PT0S"),
                new XElement(Ns + "Priority", "5")),
            new XElement(Ns + "Actions", new XAttribute("Context", "Author"),
                new XElement(Ns + "Exec",
                    new XElement(Ns + "Command", executable),
                    new XElement(Ns + "Arguments", "--hidden"),
                    new XElement(Ns + "WorkingDirectory", Path.GetDirectoryName(executable)))))).ToString();

    // The task's single action as a Run-style command line, or null when it is not one executable.
    internal static string? ReadCommand(string xml)
    {
        var actions = XDocument.Parse(xml).Descendants(Ns + "Exec").ToList();
        if (actions.Count != 1 || actions[0].Element(Ns + "Command")?.Value.Trim('"') is not { Length: > 0 } command) return null;
        var arguments = actions[0].Element(Ns + "Arguments")?.Value;
        return string.IsNullOrEmpty(arguments) ? $"\"{command}\"" : $"\"{command}\" {arguments}";
    }
}
