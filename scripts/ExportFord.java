// Ghidra headless export; no calling conventions or analyst labels are assumed.
// @category FordRacing
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import com.google.gson.GsonBuilder;
import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ExportFord extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected absolute output directory");
        File output = new File(args[0]);
        if (!output.isAbsolute()) throw new IllegalArgumentException("Output path must be absolute");
        if (!output.isDirectory() && !output.mkdirs()) throw new IllegalStateException("Cannot create output directory");
        DecompInterface decompiler = new DecompInterface();
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
        List<Map<String,Object>> failures = new ArrayList<>();
        int total = 0, thunks = 0, successful = 0;
        try (PrintWriter c = new PrintWriter(new File(output, "decompiled.c"), "UTF-8");
             PrintWriter functions = new PrintWriter(new File(output, "functions.tsv"), "UTF-8");
             PrintWriter assembly = new PrintWriter(new File(output, "disassembly.txt"), "UTF-8");
             PrintWriter calls = new PrintWriter(new File(output, "calls.tsv"), "UTF-8")) {
            c.println("/* Machine-generated pseudocode. Function boundaries, calling conventions, signatures and types require individual review. */");
            functions.println("entry_va\tname\tthunk\tbody_bytes\tcalling_convention");
            calls.println("caller_entry_va\tinstruction_va\ttarget_va\ttype");
            FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
            while (iterator.hasNext()) {
                monitor.checkCancelled();
                Function function = iterator.next();
                total++;
                functions.printf("%s\t%s\t%s\t%d\t%s%n", function.getEntryPoint(), function.getName(), function.isThunk(),
                    function.getBody().getNumAddresses(), function.getCallingConventionName());
                assembly.printf("\n; %s %s%n", function.getEntryPoint(), function.getName());
                InstructionIterator instructions = currentProgram.getListing().getInstructions(function.getBody(), true);
                while (instructions.hasNext()) {
                    Instruction instruction = instructions.next();
                    StringBuilder bytes = new StringBuilder();
                    for (byte b : instruction.getBytes()) bytes.append(String.format("%02x", b & 255));
                    assembly.printf("%s  %-30s %s%n", instruction.getAddress(), bytes.toString(), instruction.toString());
                    for (Reference reference : instruction.getReferencesFrom()) {
                        if (reference.getReferenceType().isCall())
                            calls.printf("%s\t%s\t%s\t%s%n", function.getEntryPoint(), instruction.getAddress(), reference.getToAddress(), reference.getReferenceType());
                    }
                }
                if (function.isThunk()) { thunks++; continue; }
                DecompileResults result = decompiler.decompileFunction(function, 60, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
                    successful++;
                    c.printf("\n/* %s %s */\n%s\n", function.getEntryPoint(), function.getName(), result.getDecompiledFunction().getC());
                } else {
                    Map<String,Object> failed = new LinkedHashMap<>();
                    failed.put("entry_va", function.getEntryPoint().toString());
                    failed.put("name", function.getName());
                    failed.put("error", result.getErrorMessage());
                    failures.add(failed);
                }
            }
            if (c.checkError() || functions.checkError() || assembly.checkError() || calls.checkError())
                throw new IllegalStateException("Export output could not be written");
        } finally { decompiler.dispose(); }
        Map<String,Object> summary = new LinkedHashMap<>();
        summary.put("program", currentProgram.getName());
        summary.put("executable_sha256", currentProgram.getExecutableSHA256());
        summary.put("language", currentProgram.getLanguageID().toString());
        summary.put("compiler_spec", currentProgram.getCompilerSpec().getCompilerSpecID().toString());
        summary.put("functions", total);
        summary.put("thunks", thunks);
        summary.put("decompiled", successful);
        summary.put("failures", failures);
        summary.put("limit", "Decompiler success does not verify function boundaries or semantics. In particular, the reported Watcom register ABI is not modeled by this Windows baseline.");
        try (PrintWriter status = new PrintWriter(new File(output, "status.json"), "UTF-8")) {
            status.println(new GsonBuilder().setPrettyPrinting().create().toJson(summary));
            if (status.checkError()) throw new IllegalStateException("Status output could not be written");
        }
        println("Exported " + successful + " functions; " + failures.size() + " decompiler failures");
        if (!failures.isEmpty()) throw new IllegalStateException("One or more functions failed to decompile; inspect status.json");
    }
}
