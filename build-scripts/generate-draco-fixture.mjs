import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const assetsDir = path.join(rootDir, 'assets', 'models');

async function main() {
  fs.mkdirSync(assetsDir, { recursive: true });
  const dracoGlbPath = path.join(assetsDir, 'highpoly-draco.glb');

  console.log('[draco-gen] Building 200,000-triangle torus knot geometry in memory...');
  const doc = new Document();
  const scene = doc.createScene('Scene');
  const node = doc.createNode('TorusKnot');
  const mesh = doc.createMesh('TorusKnotMesh');
  const prim = doc.createPrimitive();

  // Torus knot parameters: 400 tubular * 250 radial * 2 = 200,000 triangles
  const tubularSegments = 400;
  const radialSegments = 250;
  const p = 2;
  const q = 3;
  const radius = 1.0;
  const tube = 0.35;

  const numVertices = (tubularSegments + 1) * (radialSegments + 1);
  const positions = new Float32Array(numVertices * 3);
  const normals = new Float32Array(numVertices * 3);
  const indices = new Uint32Array(tubularSegments * radialSegments * 6);

  let vIdx = 0;
  for (let i = 0; i <= tubularSegments; i++) {
    const u = (i / tubularSegments) * p * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const quOverP = (q / p) * u;
    const cqu = Math.cos(quOverP);
    const squ = Math.sin(quOverP);

    // Center curve point
    const cx = (radius + tube * cqu) * cu;
    const cy = (radius + tube * cqu) * su;
    const cz = tube * squ;

    // Tangent approximation
    const uNext = u + 0.01;
    const cuN = Math.cos(uNext);
    const suN = Math.sin(uNext);
    const quN = (q / p) * uNext;
    const cxN = (radius + tube * Math.cos(quN)) * cuN;
    const cyN = (radius + tube * Math.cos(quN)) * suN;
    const czN = tube * Math.sin(quN);

    let tx = cxN - cx, ty = cyN - cy, tz = czN - cz;
    const tLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tLen; ty /= tLen; tz /= tLen;

    // Normal vector
    let nx = cx, ny = cy, nz = 0;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;

    // Binormal = T x N
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;

    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);

      const normX = cv * nx + sv * bx;
      const normY = cv * ny + sv * by;
      const normZ = cv * nz + sv * bz;

      positions[vIdx * 3] = cx + tube * normX;
      positions[vIdx * 3 + 1] = cy + tube * normY;
      positions[vIdx * 3 + 2] = cz + tube * normZ;

      normals[vIdx * 3] = normX;
      normals[vIdx * 3 + 1] = normY;
      normals[vIdx * 3 + 2] = normZ;

      vIdx++;
    }
  }

  let iIdx = 0;
  for (let j = 0; j < tubularSegments; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = (radialSegments + 1) * j + i;
      const b = (radialSegments + 1) * (j + 1) + i;
      const c = (radialSegments + 1) * (j + 1) + i + 1;
      const d = (radialSegments + 1) * j + i + 1;

      // Triangle 1: a -> b -> d
      indices[iIdx++] = a;
      indices[iIdx++] = b;
      indices[iIdx++] = d;

      // Triangle 2: b -> c -> d
      indices[iIdx++] = b;
      indices[iIdx++] = c;
      indices[iIdx++] = d;
    }
  }

  const buffer = doc.createBuffer('buffer');
  const posAccessor = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
  const normAccessor = doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer);
  const idxAccessor = doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer);

  prim.setAttribute('POSITION', posAccessor);
  prim.setAttribute('NORMAL', normAccessor);
  prim.setIndices(idxAccessor);

  const mat = doc.createMaterial('Material').setRoughnessFactor(0.3).setMetallicFactor(0.7);
  prim.setMaterial(mat);

  mesh.addPrimitive(prim);
  node.setMesh(mesh);
  scene.addChild(node);

  console.log(`[draco-gen] Geometry created: ${positions.length / 3} vertices, ${indices.length / 3} triangles.`);

  console.log('[draco-gen] Applying Draco compression...');
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  await doc.transform(
    draco({
      compressionLevel: 7,
      quantizePosition: 14,
      quantizeNormal: 10,
    })
  );

  const compressedGlb = await io.writeBinary(doc);
  fs.writeFileSync(dracoGlbPath, Buffer.from(compressedGlb));

  const dracoSizeKB = (compressedGlb.length / 1024).toFixed(1);
  console.log(`[draco-gen] Compressed Draco GLB size: ${dracoSizeKB} KB`);
  console.log(`[draco-gen] Generated fixture saved to: ${dracoGlbPath}`);
}

main().catch((err) => {
  console.error('[draco-gen] Failed to generate Draco fixture:', err);
  process.exit(1);
});
