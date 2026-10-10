// Validate a fresh import of the exported GZF without reanalysis.
// @category FordRacing
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import java.io.File;
import java.io.PrintWriter;

public class VerifyAnnotated extends GhidraScript {
    @Override
    public void run() throws Exception {
        if (!"87cc71d881a2723784097108ce2923fe8d0384ea6a8b03fad3e95c5cda52e8b3".equals(currentProgram.getExecutableSHA256()))
            throw new IllegalStateException("Snapshot identity mismatch");
        Function reader = getFunctionAt(toAddr(0x0042e680L));
        if (reader == null || !reader.getName().equals("fr3_read_float") || reader.getParameterCount() != 1 ||
            !reader.getParameter(0).getVariableStorage().toString().startsWith("EAX:") ||
            !reader.getReturnType().getName().equals("float") ||
            !reader.getReturn().getVariableStorage().toString().startsWith("ST0:"))
            throw new IllegalStateException("Float reader annotation/storage not preserved");
        Function cleanup = getFunctionAt(toAddr(0x00523dc0L));
        if (cleanup == null || !cleanup.getName().equals("fr3_free_tyre_tables"))
            throw new IllegalStateException("Manually identified callback not preserved");
        Function copy = getFunctionAt(toAddr(0x00524090L));
        if (copy == null || copy.getParameterCount() != 2 ||
            !copy.getParameter(0).getVariableStorage().toString().startsWith("EAX:") ||
            !copy.getParameter(1).getVariableStorage().toString().startsWith("EDX:"))
            throw new IllegalStateException("Tyre copy register storage not preserved");
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected absolute result JSON path");
        File out = new File(args[0]);
        if (!out.isAbsolute()) throw new IllegalArgumentException("Absolute result path required");
        try (PrintWriter json = new PrintWriter(out, "UTF-8")) {
            json.println("{\"import_verified\":true,\"executable_identity_verified\":true,\"eax_parameter_verified\":true,\"float_st0_return_verified\":true,\"tyre_callback_verified\":true,\"tyre_copy_registers_verified\":true}");
            if (json.checkError()) throw new IllegalStateException("Could not write result");
        }
        println("Annotated snapshot verified after fresh import without reanalysis");
    }
}
