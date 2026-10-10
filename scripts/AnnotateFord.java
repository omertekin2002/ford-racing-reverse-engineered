// Selected, evidence-based annotations. Standard import conventions retained.
// @category FordRacing
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.*;
import ghidra.program.model.data.*;
import ghidra.program.model.symbol.SourceType;
import com.google.gson.GsonBuilder;
import java.io.File;
import java.io.PrintWriter;
import java.util.*;

public class AnnotateFord extends GhidraScript {
    private static final String HASH = "87cc71d881a2723784097108ce2923fe8d0384ea6a8b03fad3e95c5cda52e8b3";
    private final List<Function> selected = new ArrayList<>();

    private Function label(long va, String name, String evidence) throws Exception {
        Function function = getFunctionAt(toAddr(va));
        if (function == null && va == 0x00523dc0L) {
            // This callback is passed as an address in the tyre loader; the
            // baseline analyzer did not identify it as a function.
            if (getFunctionContaining(toAddr(va)) != null)
                throw new IllegalStateException("Callback overlaps an existing function");
            byte[] bytes = getBytes(toAddr(va), 5);
            if (!Arrays.equals(bytes, new byte[]{0x53, 0x51, 0x52, 0x56, 0x57}))
                throw new IllegalStateException("Unexpected callback instruction bytes");
            disassemble(toAddr(va));
            function = createFunction(toAddr(va), name);
        }
        if (function == null) throw new IllegalStateException("No discovered function at " + Long.toHexString(va));
        function.setName(name, SourceType.USER_DEFINED);
        function.setComment("Analyst-assigned name; not an original symbol. " + evidence +
            " Only selected signatures are corrected; unresolved callees retain the baseline Windows model.");
        selected.add(function);
        return function;
    }

    private void signature(Function function, DataType result, String[] names, DataType[] types, String[] registers) throws Exception {
        function.setCustomVariableStorage(false);
        function.setCallingConvention("__cdecl");
        function.setReturnType(result, SourceType.USER_DEFINED);
        VariableStorage outputStorage = function.getReturn().getVariableStorage();
        ReturnParameterImpl returnValue = new ReturnParameterImpl(result, outputStorage, currentProgram);
        List<Variable> parameters = new ArrayList<>();
        for (int i = 0; i < names.length; i++)
            parameters.add(new ParameterImpl(names[i], types[i], currentProgram.getRegister(registers[i]), currentProgram, SourceType.USER_DEFINED));
        function.updateFunction("__cdecl", returnValue, parameters, Function.FunctionUpdateType.CUSTOM_STORAGE, true, SourceType.USER_DEFINED);
        function.setStackPurgeSize(0);
    }

    private void noArguments(Function function) throws Exception {
        signature(function, VoidDataType.dataType, new String[]{}, new DataType[]{}, new String[]{});
    }

    private void reader(long va, String name, DataType result) throws Exception {
        Function function = label(va, name, "Reader is supplied in EAX; return storage follows instruction usage (integer EAX or floating ST0).");
        signature(function, result, new String[]{"reader"}, new DataType[]{new PointerDataType(VoidDataType.dataType)}, new String[]{"EAX"});
    }

    @Override
    public void run() throws Exception {
        if (!HASH.equals(currentProgram.getExecutableSHA256())) throw new IllegalStateException("Unexpected executable identity");
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected absolute selected-output directory");
        File output = new File(args[0]);
        if (!output.isAbsolute()) throw new IllegalArgumentException("Absolute path required");
        output.mkdirs();
        DataType ptr = new PointerDataType(VoidDataType.dataType);
        label(0x00409b80L, "fr3_load_directx_libraries", "LoadLibraryA/GetProcAddress references to DirectX DLLs and entry points.");
        label(0x0040ba30L, "fr3_load_compressed_resource", "File-size prefix and inflate path; actual resources decode as length plus zlib stream.");
        Function pcg = label(0x00423b20L, "fr3_build_pcg_view", "Object pointer in EAX; 16-byte entries and payload alignment mask 0xffffff80.");
        signature(pcg, VoidDataType.dataType, new String[]{"collection"}, new DataType[]{ptr}, new String[]{"EAX"});
        reader(0x0042e610L, "fr3_read_integer", IntegerDataType.dataType);
        reader(0x0042e680L, "fr3_read_float", FloatDataType.dataType);
        reader(0x0042d380L, "fr3_ascii_read_integer", IntegerDataType.dataType);
        reader(0x0042d430L, "fr3_ascii_read_float", FloatDataType.dataType);
        reader(0x0042db90L, "fr3_binary_read_integer", IntegerDataType.dataType);
        reader(0x0042dbd0L, "fr3_binary_read_float", FloatDataType.dataType);
        Function tag = label(0x0042e530L, "fr3_next_tag", "Reader dispatch, application tag table, parser mode in EDX.");
        signature(tag, IntegerDataType.dataType, new String[]{"reader", "mode"}, new DataType[]{ptr, IntegerDataType.dataType}, new String[]{"EAX", "EDX"});
        Function stringReader = label(0x0042e7c0L, "fr3_read_string", "Caller supplies EAX reader, EDX destination, EBX byte limit.");
        signature(stringReader, Undefined4DataType.dataType, new String[]{"reader", "destination", "limit"}, new DataType[]{ptr, ptr, IntegerDataType.dataType}, new String[]{"EAX", "EDX", "EBX"});
        Function enumReader = label(0x0042e820L, "fr3_read_enum", "Caller supplies EAX reader, EDX enum table, EBX entry count.");
        signature(enumReader, IntegerDataType.dataType, new String[]{"reader", "table", "count"}, new DataType[]{ptr, ptr, IntegerDataType.dataType}, new String[]{"EAX", "EDX", "EBX"});
        noArguments(label(0x005227f0L, "fr3_load_engine_database", "Tag branches, 0xb0-byte payload, field stores and ENGDATA filename context."));
        noArguments(label(0x00523220L, "fr3_load_gearbox_database", "Tag branches, 0x34-byte payload and GEARDATA filename context."));
        noArguments(label(0x00523820L, "fr3_load_tyre_database", "Tag branches, 0x58-byte payload and TYREDATA filename context."));
        long[] copies = {0x00522c80L, 0x00523470L, 0x00524090L};
        String[] copyNames = {"fr3_copy_engine_record", "fr3_copy_gearbox_record", "fr3_copy_tyre_scalar_fields"};
        for (int i = 0; i < copies.length; i++) {
            Function function = label(copies[i], copyNames[i], "Field-wise stores from EDX source to EAX destination.");
            signature(function, VoidDataType.dataType, new String[]{"destination", "source"}, new DataType[]{ptr, ptr}, new String[]{"EAX", "EDX"});
        }
        Function cleanup = label(0x00523dc0L, "fr3_free_tyre_tables", "Checks/frees the five table pointers at +0x44 through +0x54; record in EAX.");
        signature(cleanup, VoidDataType.dataType, new String[]{"record"}, new DataType[]{ptr}, new String[]{"EAX"});
        long[] accessors = {0x00523e50L, 0x00523e70L, 0x00523e90L, 0x00523eb0L, 0x00523f10L};
        String[] accessorNames = {"fr3_get_tyre_vertical_load", "fr3_get_tyre_camber_thrust", "fr3_get_tyre_longitudinal_table", "fr3_get_tyre_lateral_table", "fr3_get_tyre_sound_info"};
        for (int i = 0; i < accessors.length; i++) {
            Function function = label(accessors[i], accessorNames[i], "Returns local table or follows inherited address at +0x14; EAX input and result.");
            signature(function, ptr, new String[]{"record"}, new DataType[]{ptr}, new String[]{"EAX"});
        }
        Function sound = label(0x00523ed0L, "fr3_get_tyre_sound_values", "Selects row at sound_info + 0x78 + index*0x28; EAX record, EDX index.");
        signature(sound, ptr, new String[]{"record", "index"}, new DataType[]{ptr, IntegerDataType.dataType}, new String[]{"EAX", "EDX"});

        List<Map<String,Object>> status = new ArrayList<>();
        DecompInterface decompiler = new DecompInterface();
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
        try (PrintWriter c = new PrintWriter(new File(output, "selected.c"), "UTF-8")) {
            c.println("/* Analyst-labelled Ghidra pseudocode. Selected register signatures corrected; unresolved callees and inferred types still require review. */");
            for (Function function : selected) {
                monitor.checkCancelled();
                Map<String,Object> item = new LinkedHashMap<>();
                item.put("entry_va", function.getEntryPoint().toString());
                item.put("label", function.getName());
                item.put("signature", function.getPrototypeString(false, false));
                item.put("return_storage", function.getReturn().getVariableStorage().toString());
                List<String> parameters = new ArrayList<>();
                for (Parameter parameter : function.getParameters()) parameters.add(parameter.getName() + ":" + parameter.getVariableStorage());
                item.put("parameter_storage", parameters);
                DecompileResults result = decompiler.decompileFunction(function, 60, monitor);
                boolean passed = result.decompileCompleted() && result.getDecompiledFunction() != null;
                item.put("decompiled", passed); item.put("error", result.getErrorMessage()); status.add(item);
                if (!passed) throw new IllegalStateException("Selected decompilation failed: " + function.getName());
                c.printf("\n/* %s %s */\n%s\n", function.getEntryPoint(), function.getName(), result.getDecompiledFunction().getC());
            }
            if (c.checkError()) throw new IllegalStateException("Cannot write selected output");
        } finally { decompiler.dispose(); }
        try (PrintWriter json = new PrintWriter(new File(output, "status.json"), "UTF-8")) {
            json.println(new GsonBuilder().setPrettyPrinting().create().toJson(status));
            if (json.checkError()) throw new IllegalStateException("Cannot write status");
        }
        // Headless saves the program after the script transaction completes.
        // ExportSnapshot runs afterward to pack that persisted program.
        println("Annotated/exported " + selected.size() + " functions");
    }
}
