"""Reproduce the verified demo analysis using the prepared toolchain."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from fr3_common import EXE_SHA256, verified_exe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools-root", type=Path, default=Path("/workspace/toolchains/fr3"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    tools = args.tools_root.resolve()
    python = tools / "venv/bin/python"
    artifacts = root / "artifacts"
    logs = artifacts / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    (root / "analysis").mkdir(exist_ok=True)
    env = os.environ.copy()
    env["JAVA_TOOL_OPTIONS"] = "-Duser.home=" + str(tools / "state")

    def run(argv):
        subprocess.run([str(x) for x in argv], cwd=root, check=True)

    def headless(arguments, name, expected_marker):
        logfile = logs / name
        with logfile.open("w") as stream:
            subprocess.run([str(tools / "ghidra_10.3.3_PUBLIC/support/analyzeHeadless"), *[str(x) for x in arguments]], cwd=root,
                           env=env, stdout=stream, stderr=subprocess.STDOUT, check=True)
        text = logfile.read_text()
        if "REPORT SCRIPT ERROR" in text or expected_marker not in text:
            raise RuntimeError(f"Ghidra did not complete the requested operation; see {logfile}")
        print(expected_marker)

    run([python, "scripts/acquire_demo.py", "inputs", "--unshield", tools / "bin/unshield"])
    verified_exe(root / "inputs/fr3.exe")
    game = root / "inputs/extracted/Program_Executable_Files"
    manifest = [{"path": p.relative_to(game).as_posix(), "size": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in sorted(game.rglob("*")) if p.is_file()]
    recorded = root / "analysis/game-file-manifest.json"
    if recorded.exists() and json.loads(recorded.read_text()) != manifest:
        raise ValueError("Extracted game files differ from recorded manifest; existing files preserved")
    recorded.write_text(json.dumps(manifest, indent=2) + "\n")
    run([python, "scripts/inspect_pe.py", "inputs/fr3.exe", "artifacts/pe"])
    run([python, "scripts/extract_tag_registry.py", "inputs/fr3.exe", "analysis/tags.json"])
    run([python, "scripts/extract_selected.py", "inputs/fr3.exe", "analysis/selected"])
    run([python, "scripts/unpack_resources.py", game, "artifacts/unpacked"])
    run([python, "scripts/index_pcg.py", "artifacts/unpacked", "analysis/pcg-index.json"])
    for source, destination in (("artifacts/pe/metadata.json", "analysis/pe-metadata.json"),
                                ("artifacts/unpacked/unpacked_manifest.json", "analysis/unpacked-manifest.json")):
        (root / destination).write_bytes((root / source).read_bytes())
    project = root / "artifacts/project"
    project.mkdir(exist_ok=True)
    baseline = root / "artifacts/ghidra/status.json"
    if baseline.exists() and (root / "artifacts/ghidra/decompiled.c").is_file():
        status = json.loads(baseline.read_text())
        if status["executable_sha256"] != EXE_SHA256 or status["compiler_spec"] != "windows" or status["failures"]:
            raise ValueError("Existing baseline is unsuitable; preserve it and inspect its status")
        print("Reusing completed, identity-matching baseline exports")
    else:
        if (project / "FordRacing3.gpr").exists():
            raise ValueError("Existing project has no complete baseline exports; preserve it before rebuilding")
        headless([project, "FordRacing3", "-import", root / "inputs/fr3.exe", "-processor", "x86:LE:32:default", "-cspec", "windows",
                  "-max-cpu", "4", "-scriptPath", root / "scripts", "-postScript", "ExportFord.java", root / "artifacts/ghidra"],
                 "baseline.log", "Exported 4770 functions; 0 decompiler failures")
    (root / "analysis/baseline-status.json").write_bytes(baseline.read_bytes())
    headless([project, "FordRacing3", "-process", "fr3.exe", "-noanalysis", "-scriptPath", root / "scripts", "-postScript",
              "AnnotateFord.java", root / "analysis/annotated"], "annotate.log", "Annotated/exported 25 functions")
    headless([project, "FordRacing3", "-process", "fr3.exe", "-noanalysis", "-scriptPath", root / "scripts", "-postScript",
              "ExportSnapshot.java", root / "artifacts/fr3-demo-annotated.gzf"], "snapshot-export.log", "Packed annotated snapshot:")
    verification_project = root / "artifacts/verification-project"
    verification_project.mkdir(exist_ok=True)
    headless([verification_project, "FR3SnapshotVerify", "-import", root / "artifacts/fr3-demo-annotated.gzf", "-noanalysis",
              "-scriptPath", root / "scripts", "-postScript", "VerifyAnnotated.java", root / "analysis/snapshot-verification.json", "-deleteProject"],
             "snapshot-verify.log", "Annotated snapshot verified after fresh import without reanalysis")
    run([python, "-m", "unittest", "discover", "-s", "tests", "-v"])
    run([python, "scripts/verify_findings.py", root])


if __name__ == "__main__":
    main()
