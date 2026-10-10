// Run after AnnotateFord has completed and headless has saved its project.
// @category FordRacing
import ghidra.app.script.GhidraScript;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

public class ExportSnapshot extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected absolute GZF path");
        File target = new File(args[0]);
        if (!target.isAbsolute()) throw new IllegalArgumentException("Absolute path required");
        if (currentProgram.getFunctionManager().getFunctionAt(toAddr(0x00523820L)) == null ||
            !currentProgram.getFunctionManager().getFunctionAt(toAddr(0x00523820L)).getName().equals("fr3_load_tyre_database"))
            throw new IllegalStateException("Expected persisted analyst annotations");
        target.getParentFile().mkdirs();
        File directory = Files.createTempDirectory(target.getParentFile().toPath(), "fr3-export-").toFile();
        File pending = new File(directory, "program.gzf");
        try {
            currentProgram.getDomainFile().packFile(pending, monitor);
            Files.move(pending.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } finally { pending.delete(); directory.delete(); }
        println("Packed annotated snapshot: " + target);
    }
}
