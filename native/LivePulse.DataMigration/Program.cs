using System.Text.Json;

namespace LivePulse.DataMigration;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            try { SelfTest.Run(); return 0; }
            catch (Exception error) { Console.Error.WriteLine($"Self-test failed: {error.Message}"); return 1; }
        }
        if (args.Length != 3 || args[0] is not ("--import" or "--verify"))
        {
            Console.Error.WriteLine("Usage: LivePulse.DataMigration --import|--verify SOURCE_JSON OUTPUT_SQLITE");
            return 2;
        }
        try
        {
            var source = Path.GetFullPath(args[1]);
            var database = Path.GetFullPath(args[2]);
            if (string.Equals(source, database, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Source and output paths must differ.");
            var result = args[0] == "--import"
                ? StoreImporter.Import(source, database)
                : StoreImporter.Verify(source, database);
            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Migration stopped: {error.Message}");
            return 1;
        }
    }
}
