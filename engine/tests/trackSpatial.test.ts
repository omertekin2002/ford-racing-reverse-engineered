import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DemoAssets, trackDirectory } from "../src/demoAssets.js";
import type { RacingLine } from "../src/formats/databases.js";
import { parse3dObjDb, parseBinInfo, type SceneDatabase, type SceneRoot } from "../src/formats/xbx.js";
import type { Vec3 } from "../src/math/mat4.js";
import { TrackSpatial } from "../src/physics/trackSpatial.js";
import { NodeVfs } from "../src/vfs/nodeVfs.js";

function boundary(type: number, x: number, z: number, dx: number, dz: number, length: number): Uint8Array {
  const bytes = new Uint8Array(28);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, type, true);
  [x, z, dx, dz, length, 1 / length].forEach((f, i) => view.setFloat32(4 * (i + 1), f, true));
  return bytes;
}

test("scene walls retain high material indices and exclude telegraph links, mode records and route crossings", () => {
  const line: RacingLine = {
    version: 1, creationDate: "", timestamp: 0, sceneName: "", tolerance: 0, reverse: false,
    length: 100, edgeModifier: 1, flyingLapStartInterpolant: 0, metadata: {},
    points: [0, 100].map(z => ({
      position: [0, 0, z], width: 30, forward: [0, 0, 1], lateral: [1, 0, 0], offset: 0, curvatureRadius: 300,
    })),
  };
  const root: SceneRoot = {
    shapeId: 0, transforms: [], points: new Float32Array(), references: [], secondaryRecords: [],
    mode: 4, modeBoundaries: [boundary(0, 7, 0, 0, 1, 100)], cameras: [], modePairs: [],
    lodValues: new Float32Array(), declaredInlineChildren: 0, declaredChildPairs: 0, preMeshWords: new Uint32Array(),
    meshSlotId: 0, controlWords: [0, 0], meshPairs: [], children: { kind: "inline", nodes: [] },
    boundaries: [
      boundary(0, -6, 0, 0, 1, 100), boundary(3, 5, 0, 0, 1, 100),
      boundary(3, -10, 40, 1, 0, 20),
    ],
  };
  const placement: SceneRoot = {
    ...root, shapeId: 1, mode: 0, modeBoundaries: [], secondaryRecords: [new Uint8Array(32)],
    boundaries: [boundary(6, 8, 0, 0, 1, 100)],
  };
  const scene: SceneDatabase = {
    version: 18, header: new Uint32Array(), roots: [root, placement], animationGroups: [],
    boundaryGroups: [], namedRecords: [],
  };
  const boundaryTypes = ["DEFAULT", "METAL", "HEDGE", "STONE", "WOOD", "SNOW", "TELEGRAPH_LINK_TYPE_A"];
  for (const types of [boundaryTypes, undefined]) {
    const track = new TrackSpatial([], scene, line, { boundaryTypes: types });
    const contacts = (x: number, z: number) => track.queryBarrierContacts([{ center: [x, 0, z], radius: 0.2 }]);
    assert.equal(contacts(-6, 50).length, 1);
    assert.equal(contacts(5, 50).length, 1);
    assert.deepEqual(contacts(7, 50), []);
    assert.deepEqual(contacts(8, 50), []);
    assert.deepEqual(contacts(0, 40), []);
  }
});

const game = fileURLToPath(new URL("../../game", import.meta.url));

test("no physical scene wall crosses the authored racing line on any installed track",
  { skip: !existsSync(game) }, async () => {
    const vfs = await NodeVfs.open(game);
    const assets = await DemoAssets.load(vfs);
    assert.equal(assets.installedTracks.length, 125);
    const crossingTracks: string[] = [];
    for (const { id } of assets.installedTracks) {
      const { racingLine } = await assets.loadTrackData(id);
      const dir = trackDirectory(id);
      const [info, db] = await Promise.all([vfs.readUnpacked(`${dir}/bininfo.bin`), vfs.readUnpacked(`${dir}/3dobjdb.bin`)]);
      const scene = parse3dObjDb(db, parseBinInfo(info));
      const track = new TrackSpatial([], scene, racingLine);
      let checked = 0;
      for (const root of scene.roots) {
        for (const raw of root.boundaries) {
          const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const x = data.getFloat32(4, true), z = data.getFloat32(8, true);
          const length = data.getFloat32(20, true);
          const dx = data.getFloat32(12, true) * length, dz = data.getFloat32(16, true) * length;
          const left = Math.min(x, x + dx), right = Math.max(x, x + dx);
          const near = Math.min(z, z + dz), far = Math.max(z, z + dz);
          for (const [i, { position: [ax, ay, az] }] of racingLine.points.entries()) {
            const [bx, by, bz] = racingLine.points[(i + 1) % racingLine.points.length]!.position;
            if (Math.max(ax, bx) < left || Math.min(ax, bx) > right ||
                Math.max(az, bz) < near || Math.min(az, bz) > far) continue;
            // Solve the 2D segment intersection with each authored route chord.
            const rx = bx - ax, rz = bz - az;
            const determinant = dx * rz - dz * rx;
            const wallFraction = ((ax - x) * rz - (az - z) * rx) / determinant;
            const routeFraction = ((ax - x) * dz - (az - z) * dx) / determinant;
            if (!(wallFraction > 0 && wallFraction < 1 && routeFraction > 0 && routeFraction < 1)) continue;
            const center: Vec3 = [x + dx * wallFraction, ay + (by - ay) * routeFraction, z + dz * wallFraction];
            assert.deepEqual(track.queryBarrierContacts([{ center, radius: 1e-4 }]), [], `${id} route segment ${i}`);
            checked++;
          }
        }
      }
      if (checked) crossingTracks.push(id);
    }
    for (const id of ["DTOWN3F", "SANTA1F", "BEACH2R", "NTOWN3F", "ENGBF"]) {
      assert.ok(crossingTracks.includes(id), `${id} must exercise the crossing regression`);
    }
  });
