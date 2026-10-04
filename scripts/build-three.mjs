// 3D の盤面（src/ui/cube3d.js）で使う three.js（MIT ライセンス）の部品だけを 1 つのファイルにまとめて、src/ui/vendor/three.js に書き出す。
// three.js は全部で 2MB 以上あるが、使う部品だけに絞ると約 520KB（gzip で約 130KB）。3D を選んだときだけ読み込む。
// 作り直すとき: npm i --no-save three@0.186.1 esbuild && node scripts/build-three.mjs
import { build } from 'esbuild';
import { copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const VERSION = '0.186.1';
const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve('three')), '..');      // three/build/three.cjs -> three/
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== VERSION) throw new Error(`three@${VERSION} が必要（入っているのは ${pkg.version}）`);
const names = [
  'WebGLRenderer', 'WebGLRenderTarget', 'Scene', 'Camera', 'Mesh', 'InstancedMesh', 'Group',
  'BufferGeometry', 'BufferAttribute', 'InstancedBufferAttribute', 'PlaneGeometry', 'ShaderMaterial', 'DataTexture',
  'Vector2', 'Vector3', 'Vector4', 'Matrix3', 'Matrix4', 'Color',
  'HalfFloatType', 'UnsignedByteType', 'LinearFilter', 'RGBAFormat', 'ClampToEdgeWrapping',
  'NoToneMapping', 'LinearSRGBColorSpace', 'NoColorSpace', 'SRGBColorSpace',
  'NoBlending', 'NormalBlending', 'AdditiveBlending', 'CustomBlending', 'DstColorFactor', 'ZeroFactor', 'OneFactor',
  'OneMinusSrcAlphaFactor', 'SrcAlphaFactor', 'SrcColorFactor', 'DstAlphaFactor', 'FloatType', 'AddEquation', 'FrontSide', 'BackSide', 'DoubleSide', 'GLSL3', 'REVISION', 'ShaderChunk',
];
await build({
  stdin: { contents: `export { ${names.join(', ')} } from 'three';`, resolveDir: process.cwd(), loader: 'js' },
  bundle: true, format: 'esm', minify: true, legalComments: 'inline', target: 'es2020',
  outfile: 'src/ui/vendor/three.js',
});
copyFileSync(join(root, 'LICENSE'), 'src/ui/vendor/three-LICENSE.txt');
console.log(`three@${VERSION} -> src/ui/vendor/three.js`);
