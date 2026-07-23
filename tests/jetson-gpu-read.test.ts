import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDcgmMetrics,
  parseJetsonGpuLoad,
  parseMeminfoUsedMiB,
  parseOllamaPsModels,
  parseThermalTempMilliC,
  pickGpuLoadPath,
} from '../src/admin/gpuStats.js';

describe('jetson gpu parse helpers', () => {
  it('converts sysfs GPU load to percent', () => {
    assert.equal(parseJetsonGpuLoad(450), 45);
    assert.equal(parseJetsonGpuLoad('29'), 2.9);
    assert.equal(parseJetsonGpuLoad('not-a-number'), undefined);
  });

  it('parses meminfo used and total MiB', () => {
    const content = [
      'MemTotal:       7815168 kB',
      'MemAvailable:   3123456 kB',
    ].join('\n');
    assert.deepEqual(parseMeminfoUsedMiB(content), {
      usedMiB: 4581,
      totalMiB: 7632,
    });
  });

  it('parses thermal temp millidegrees to Celsius', () => {
    assert.equal(parseThermalTempMilliC(52500), 52.5);
    assert.equal(parseThermalTempMilliC('39000'), 39);
  });

  it('picks the first known GPU load path', () => {
    assert.equal(
      pickGpuLoadPath([
        '/sys/devices/platform/host1x/gpu.0/load',
        '/sys/devices/gpu.0/load',
      ]),
      '/sys/devices/gpu.0/load'
    );
    assert.equal(
      pickGpuLoadPath(['/sys/devices/57000000.gpu/load']),
      '/sys/devices/57000000.gpu/load'
    );
  });

  it('derives Ollama VRAM and offload percent from /api/ps models', () => {
    assert.deepEqual(
      parseOllamaPsModels([
        { size: 4_000_000_000, size_vram: 3_000_000_000 },
        { size: 2_000_000_000, size_vram: 2_000_000_000 },
      ]),
      {
        modelVramMiB: 4768,
        gpuOffloadPercent: 83,
      }
    );
  });

  it('parses DCGM prometheus metrics', () => {
    const text = [
      'DCGM_FI_DEV_GPU_UTIL{gpu="0"} 42',
      'DCGM_FI_DEV_FB_USED{gpu="0"} 5120',
      'DCGM_FI_DEV_FB_FREE{gpu="0"} 1024',
      'DCGM_FI_DEV_GPU_TEMP{gpu="0"} 61',
      'DCGM_FI_DEV_POWER_USAGE{gpu="0"} 88.5',
    ].join('\n');
    assert.deepEqual(parseDcgmMetrics(text), {
      source: 'dcgm',
      utilizationPercent: 42,
      memoryUsedMiB: 5120,
      memoryFreeMiB: 1024,
      temperatureC: 61,
      powerWatts: 88.5,
    });
  });
});
