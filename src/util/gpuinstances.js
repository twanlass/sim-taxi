/**
 * Instance matrices as a vertex buffer, for every `InstancedMesh` under WebGPURenderer.
 *
 * three (r180, `InstanceNode.setup`) reads the matrices of a mesh with up to 1000 instances from
 * a uniform array, and **the array's length is in the shader**: `array<mat4x4f, 12>` for a pool
 * of twelve. So two meshes that differ only in how many instances they can hold are two shader
 * modules and two pipelines, and a mesh made mid-run builds both on the frame it is first drawn.
 * WebGL has no such thing: a program is the same whatever the count. The garbage piles are made
 * as the run goes, each as big as its heap, and every new size was a stall of its own (measured
 * headless: 15 of the 36 pipelines built after the load were `trash-pile`).
 *
 * Past 1000 instances three already uses a vertex buffer, which says nothing about the count.
 * This takes that path for every size, by handing the node its matrix before three chooses.
 */
import { DynamicDrawUsage, InstancedInterleavedBuffer } from 'three';
import { InstanceNode } from 'three/webgpu';
import { instancedBufferAttribute, instancedDynamicBufferAttribute, mat4 } from 'three/tsl';

let installed = false;
export function installInstanceAttributes() {
  if (installed) return;
  installed = true;
  const setup = InstanceNode.prototype.setup;
  InstanceNode.prototype.setup = function setupWithAttributes(builder) {
    if (this.instanceMatrixNode === null) {
      const { instanceMatrix } = this;
      // The same construction as three's own branch for more than 1000 instances.
      const buffer = new InstancedInterleavedBuffer(instanceMatrix.array, 16, 1);
      this.buffer = buffer;
      const column = instanceMatrix.usage === DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;
      this.instanceMatrixNode = mat4(
        column(buffer, 'vec4', 16, 0), column(buffer, 'vec4', 16, 4),
        column(buffer, 'vec4', 16, 8), column(buffer, 'vec4', 16, 12),
      );
    }
    return setup.call(this, builder);
  };
}
