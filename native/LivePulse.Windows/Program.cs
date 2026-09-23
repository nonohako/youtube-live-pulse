using System.Windows;

namespace LivePulse.Windows;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var app = new PrototypeApp(args);
        app.Run();
    }
}
