import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Html, Line, OrbitControls } from "@react-three/drei";
import { Activity, Gauge, Pause, Play, Radar, RotateCcw } from "lucide-react";
import * as THREE from "three";

const WATER_LEVEL = -0.35;
const SONAR_Y = 0.58;
const SONAR_Z = 0.55;
const SCAN_START_X = -6.2;
const SCAN_END_X = 6.6;
const PIER_X = 0.9;
const PIER_Z = 0.55;
const BASE_BED_Y = -4.2;
const PIT_EXTRA_DEPTH = 2.25;
const UPDATE_RATE = 1 / 24;
const LOG_RATE = 0.22;

const MODES = {
  scan: "连续测距",
  rescan: "桥墩复测",
  alarm: "深坑告警",
};

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function scanPose(progress) {
  return {
    x: THREE.MathUtils.lerp(SCAN_START_X, SCAN_END_X, progress),
    y: SONAR_Y,
    z: SONAR_Z,
  };
}

function baseBedYAt(x, z) {
  const ripple = 0.1 * Math.sin(x * 1.15) * Math.cos(z * 1.35);
  const sandWave = 0.06 * Math.sin(x * 2.3 + z * 0.7);
  return BASE_BED_Y - ripple + sandWave;
}

function trueBedYAt(x, z, scourSeverity = 1) {
  const distance = Math.hypot(x - PIER_X, z - PIER_Z);
  const pit = Math.exp(-(distance * distance) / (2 * 1.15 * 1.15));
  return baseBedYAt(x, z) - PIT_EXTRA_DEPTH * scourSeverity * pit;
}

function simulateSonarPacket({ seq, time, scanProgress, bedMap }) {
  const pose = scanPose(scanProgress);
  const scourSeverity = 0.78 + 0.12 * Math.sin(time * 0.18);
  const bedY = trueBedYAt(pose.x, pose.z, scourSeverity);
  const baselineDistance = SONAR_Y - baseBedYAt(pose.x, pose.z);
  const rawDistance = SONAR_Y - bedY;
  const noise = (Math.random() - 0.5) * 0.08;
  const sonarDistance = Math.max(0, rawDistance + noise);
  const depthFromWater = sonarDistance - (SONAR_Y - WATER_LEVEL);
  const scourDelta = Math.max(0, sonarDistance - baselineDistance);
  const nearPier = Math.abs(pose.x - PIER_X) < 1.45;
  const pitProbability = clamp01(scourDelta / 1.35);
  const mode = scourDelta > 1.15 && nearPier ? MODES.alarm : scourDelta > 0.62 && nearPier ? MODES.rescan : MODES.scan;
  const status = mode === MODES.alarm ? "疑似深坑" : mode === MODES.rescan ? "距离增大" : "正常测距";

  const nextMap = new Map(bedMap);
  const key = pose.x.toFixed(1);
  nextMap.set(key, {
    x: Number(key),
    sonarDistance,
    bedY: SONAR_Y - sonarDistance,
    scourDelta,
    pitProbability,
  });

  return {
    packet: {
      seq,
      timestamp: `T+${time.toFixed(1)}s`,
      scanX: pose.x,
      scanZ: pose.z,
      sonarDistance,
      baselineDistance,
      depthFromWater,
      bedElevation: SONAR_Y - sonarDistance,
      scourDelta,
      pitProbability,
      status,
      mode,
      nearPier,
    },
    bedMap: nextMap,
  };
}

const initialTelemetry = {
  time: 0,
  scanProgress: 0,
  scanX: SCAN_START_X,
  scanZ: SONAR_Z,
  sonarDistance: SONAR_Y - baseBedYAt(SCAN_START_X, SONAR_Z),
  baselineDistance: SONAR_Y - baseBedYAt(SCAN_START_X, SONAR_Z),
  depthFromWater: BASE_BED_Y * -1,
  bedElevation: BASE_BED_Y,
  scourDelta: 0,
  pitProbability: 0,
  mode: MODES.scan,
  status: "正常测距",
  sensorSeq: 0,
  nearPier: false,
};

function Riverbed({ bedMap }) {
  const geometry = useMemo(() => {
    const width = 16;
    const depth = 12;
    const segments = 128;
    const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
    geometry.rotateX(-Math.PI / 2);

    const position = geometry.attributes.position;
    const colors = [];
    const color = new THREE.Color();

    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const distance = Math.hypot(x - PIER_X, z - PIER_Z);
      const pit = Math.exp(-(distance * distance) / (2 * 1.15 * 1.15));
      const y = trueBedYAt(x, z, 0.9);
      position.setY(i, y);
      color.setHSL(0.09 + pit * 0.02, 0.34 + pit * 0.18, 0.36 - pit * 0.12);
      colors.push(color.r, color.g, color.b);
    }

    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }, []);

  return (
    <group>
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.92} metalness={0.03} />
      </mesh>
      <MeasuredBedPoints bedMap={bedMap} />
    </group>
  );
}

function MeasuredBedPoints({ bedMap }) {
  const points = useMemo(
    () =>
      Array.from(bedMap.values())
        .sort((a, b) => a.x - b.x)
        .map((item) => [item.x, item.bedY + 0.08, SONAR_Z]),
    [bedMap],
  );

  return (
    <group>
      {points.length > 1 && <Line points={points} color="#67e8f9" lineWidth={2.2} transparent opacity={0.95} />}
      {Array.from(bedMap.values()).map((item) => (
        <mesh key={item.x} position={[item.x, item.bedY + 0.1, SONAR_Z]} scale={0.055}>
          <sphereGeometry args={[1, 12, 8]} />
          <meshBasicMaterial color={item.scourDelta > 1 ? "#fb7185" : "#67e8f9"} />
        </mesh>
      ))}
    </group>
  );
}

function BedSediment() {
  const grains = useMemo(
    () =>
      Array.from({ length: 120 }, (_, index) => {
        const x = -7.3 + Math.random() * 14.6;
        const z = -5.2 + Math.random() * 10.4;
        const pitDistance = Math.hypot(x - PIER_X, z - PIER_Z);
        return {
          key: index,
          position: [x, trueBedYAt(x, z, 0.9) + 0.06 + Math.random() * 0.05, z],
          scale: 0.025 + Math.random() * 0.065 + (pitDistance < 1.9 ? 0.02 : 0),
          color: pitDistance < 1.55 ? "#c08a53" : Math.random() > 0.5 ? "#9a7a55" : "#6f624f",
        };
      }),
    [],
  );

  return (
    <group>
      {grains.map((grain) => (
        <mesh key={grain.key} position={grain.position} scale={grain.scale} receiveShadow>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={grain.color} roughness={0.96} />
        </mesh>
      ))}
    </group>
  );
}

function WaterSurface() {
  return (
    <mesh position={[0, WATER_LEVEL, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[18, 13, 1, 1]} />
      <meshStandardMaterial color="#58c7e6" transparent opacity={0.26} roughness={0.18} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Bridge() {
  return (
    <group>
      <mesh position={[0.9, 0.94, 0.55]} castShadow receiveShadow>
        <boxGeometry args={[15.4, 0.32, 2.05]} />
        <meshStandardMaterial color="#9fa8b2" roughness={0.58} metalness={0.06} />
      </mesh>
      <mesh position={[0.9, 1.18, 0.55]} castShadow receiveShadow>
        <boxGeometry args={[14.9, 0.12, 1.78]} />
        <meshStandardMaterial color="#333b45" roughness={0.7} metalness={0.04} />
      </mesh>
      {[-6.25, -4.15, -2.05, 0.05, 2.15, 4.25, 6.35].map((x) => (
        <mesh key={`beam-${x}`} position={[x, 0.63, 0.55]} castShadow receiveShadow>
          <boxGeometry args={[0.18, 0.52, 2.18]} />
          <meshStandardMaterial color="#7f8993" roughness={0.68} metalness={0.05} />
        </mesh>
      ))}
      {[-0.48, 1.58].map((z) => (
        <group key={`rail-${z}`}>
          <mesh position={[0.9, 1.44, z]} castShadow>
            <boxGeometry args={[14.8, 0.08, 0.08]} />
            <meshStandardMaterial color="#d3d9df" roughness={0.46} metalness={0.12} />
          </mesh>
          {[-5.9, -4.3, -2.7, -1.1, 0.5, 2.1, 3.7, 5.3, 6.9].map((x) => (
            <mesh key={`rail-post-${z}-${x}`} position={[x, 1.3, z]} castShadow>
              <boxGeometry args={[0.07, 0.36, 0.07]} />
              <meshStandardMaterial color="#c6ced6" roughness={0.5} metalness={0.1} />
            </mesh>
          ))}
        </group>
      ))}
      {[-6.35, PIER_X, 6.95].map((x, index) => (
        <mesh key={`pier-${x}`} position={[x, -2.1, PIER_Z]} castShadow receiveShadow>
          <cylinderGeometry args={index === 1 ? [0.62, 0.82, 5.2, 64] : [0.42, 0.52, 4.9, 48]} />
          <meshStandardMaterial color={index === 1 ? "#a6adb4" : "#89919a"} roughness={0.66} metalness={0.06} />
        </mesh>
      ))}
      <mesh position={[PIER_X, -4.74, PIER_Z]} receiveShadow>
        <cylinderGeometry args={[1.08, 1.25, 0.34, 64]} />
        <meshStandardMaterial color="#6d7378" roughness={0.74} />
      </mesh>
    </group>
  );
}

function ScourMarker({ active }) {
  return (
    <group position={[PIER_X, trueBedYAt(PIER_X, PIER_Z, 0.9) + 0.08, PIER_Z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.02, 1.34, 80]} />
        <meshBasicMaterial color={active ? "#ff3f56" : "#b93a44"} transparent opacity={active ? 0.6 : 0.28} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.02, 80]} />
        <meshBasicMaterial color="#ff3048" transparent opacity={active ? 0.16 : 0.07} />
      </mesh>
    </group>
  );
}

function SonarBeam({ distance, active }) {
  return (
    <group>
      <mesh position={[0, -distance / 2, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[Math.max(0.42, distance * 0.14), distance, 48, 1, true]} />
        <meshBasicMaterial color={active ? "#45d7ff" : "#67e8f9"} transparent opacity={active ? 0.28 : 0.14} side={THREE.DoubleSide} />
      </mesh>
      <Line points={[[0, 0, 0], [0, -distance, 0]]} color="#d8fbff" lineWidth={1.4} transparent opacity={0.9} />
      <mesh position={[0, -distance, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.18, 0.29, 36]} />
        <meshBasicMaterial color={active ? "#fb7185" : "#c9fbff"} transparent opacity={0.88} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function BridgeMountedSonar({ telemetry, showBeam }) {
  return (
    <group>
      <Line points={[[SCAN_START_X, SONAR_Y + 0.08, SONAR_Z], [SCAN_END_X, SONAR_Y + 0.08, SONAR_Z]]} color="#d8e5ef" lineWidth={2} transparent opacity={0.72} />
      <group position={[telemetry.scanX, SONAR_Y, SONAR_Z]}>
        <mesh castShadow>
          <boxGeometry args={[0.62, 0.22, 0.42]} />
          <meshStandardMaterial color="#1e3145" roughness={0.42} metalness={0.18} />
        </mesh>
        <mesh position={[0, -0.2, 0]} castShadow>
          <cylinderGeometry args={[0.13, 0.13, 0.3, 24]} />
          <meshStandardMaterial color="#20e6ff" emissive="#0a8ba0" emissiveIntensity={telemetry.mode === MODES.alarm ? 0.95 : 0.32} />
        </mesh>
        {showBeam && <SonarBeam distance={telemetry.sonarDistance} active={telemetry.mode !== MODES.scan} />}
      </group>
    </group>
  );
}

function SceneLegend({ telemetry }) {
  return (
    <Html position={[-6.15, 1.55, 3.35]} center>
      <div className="w-64 rounded border border-cyan-100/20 bg-slate-950/70 p-3 text-xs leading-6 text-slate-200 shadow-2xl backdrop-blur">
        <div className="mb-1 font-semibold text-cyan-100">桥载单波束测距逻辑</div>
        <div>声呐固定在桥上，沿桥向导轨循环扫描</div>
        <div>预留变量：sonarDistance = 声呐返回距离</div>
        <div>青色点线：由测距数据反推的河床剖面</div>
        <div>红色圆环：桥墩处疑似深坑区域</div>
        <div className="mt-1 text-amber-100">当前距离：{telemetry.sonarDistance.toFixed(2)} 米</div>
        <div className="text-cyan-100">系统状态：{telemetry.mode} / {telemetry.status}</div>
      </div>
    </Html>
  );
}

function SimulationScene({ running, telemetry, setTelemetry, setDataLog, bedMap, setBedMap, showBeam, resetKey }) {
  const simRef = useRef({
    time: 0,
    scanProgress: 0,
    accumulator: 0,
    logAccumulator: 0,
    seq: 0,
    direction: 1,
    resetKey,
  });

  useFrame((_, delta) => {
    if (simRef.current.resetKey !== resetKey) {
      simRef.current = { time: 0, scanProgress: 0, accumulator: 0, logAccumulator: 0, seq: 0, direction: 1, resetKey };
      setTelemetry(initialTelemetry);
      setDataLog([]);
      setBedMap(new Map());
      return;
    }

    if (!running) return;

    const sim = simRef.current;
    sim.time += delta;
    sim.scanProgress += delta * 0.055 * sim.direction;
    if (sim.scanProgress >= 1) {
      sim.scanProgress = 1;
      sim.direction = -1;
    }
    if (sim.scanProgress <= 0) {
      sim.scanProgress = 0;
      sim.direction = 1;
    }
    sim.accumulator += delta;
    sim.logAccumulator += delta;

    if (sim.accumulator < UPDATE_RATE) return;
    sim.accumulator = 0;
    sim.seq += 1;

    const { packet, bedMap: nextMap } = simulateSonarPacket({
      seq: sim.seq,
      time: sim.time,
      scanProgress: sim.scanProgress,
      bedMap,
    });

    setBedMap(nextMap);
    setTelemetry({
      ...packet,
      time: sim.time,
      scanProgress: sim.scanProgress,
      sensorSeq: packet.seq,
    });

    if (sim.logAccumulator >= LOG_RATE) {
      sim.logAccumulator = 0;
      setDataLog((rows) => [packet, ...rows].slice(0, 14));
    }
  });

  return (
    <>
      <color attach="background" args={["#07111f"]} />
      <fog attach="fog" args={["#07111f", 8, 17]} />
      <ambientLight intensity={0.62} />
      <directionalLight position={[4, 6, 3]} intensity={1.7} castShadow shadow-mapSize={[2048, 2048]} />
      <pointLight position={[-3, -1, -2]} color="#65e6ff" intensity={1.1} distance={8} />
      <Environment preset="city" />
      <WaterSurface />
      <Riverbed bedMap={bedMap} />
      <BedSediment />
      <Bridge />
      <ScourMarker active={telemetry.mode === MODES.alarm} />
      <BridgeMountedSonar telemetry={telemetry} showBeam={showBeam} />
      <SceneLegend telemetry={telemetry} />
      <ContactShadows position={[0, -4.38, 0]} opacity={0.45} scale={13} blur={2} far={4} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={5} maxDistance={14} maxPolarAngle={Math.PI * 0.49} target={[0, -2.1, 0]} />
    </>
  );
}

function MetricBar({ label, value, tone = "cyan" }) {
  const width = `${Math.round(clamp01(value) * 100)}%`;
  const barColor = tone === "red" ? "bg-red-400" : tone === "amber" ? "bg-amber-300" : "bg-cyan-300";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-slate-300">
        <span>{label}</span>
        <span className="font-mono text-slate-100">{Math.round(clamp01(value) * 100)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-slate-700/70">
        <div className={`h-full rounded ${barColor} shadow-[0_0_16px_currentColor]`} style={{ width }} />
      </div>
    </div>
  );
}

function BedProfile({ bedMap }) {
  const samples = Array.from(bedMap.values()).sort((a, b) => a.x - b.x);
  const path =
    samples.length > 1
      ? samples
          .map((sample, index) => {
            const px = ((sample.x - SCAN_START_X) / (SCAN_END_X - SCAN_START_X)) * 100;
            const py = 82 - clamp01((sample.sonarDistance - 4.2) / 2.7) * 62;
            return `${index === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`;
          })
          .join(" ")
      : "";

  return (
    <div className="mt-5 rounded border border-cyan-100/10 bg-slate-950/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-100">声呐测距反演河床剖面</span>
        <span className="text-slate-400">距离越大，河床越深</span>
      </div>
      <svg viewBox="0 0 100 86" className="h-28 w-full overflow-visible rounded bg-slate-900/60">
        <line x1="0" y1="60" x2="100" y2="60" stroke="rgba(148,163,184,.35)" strokeDasharray="3 3" />
        <line x1="55" y1="4" x2="55" y2="84" stroke="rgba(248,113,113,.65)" strokeDasharray="3 3" />
        {path && <path d={path} fill="none" stroke="#67e8f9" strokeWidth="2.2" strokeLinecap="round" />}
        {samples.map((sample) => {
          const px = ((sample.x - SCAN_START_X) / (SCAN_END_X - SCAN_START_X)) * 100;
          const py = 82 - clamp01((sample.sonarDistance - 4.2) / 2.7) * 62;
          return <circle key={sample.x} cx={px} cy={py} r="1.4" fill={sample.scourDelta > 1 ? "#fb7185" : "#67e8f9"} />;
        })}
      </svg>
    </div>
  );
}

function SensorDataTable({ rows }) {
  return (
    <div className="mt-5 rounded border border-cyan-100/10 bg-slate-950/40 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-100">单波束声呐实时数据</p>
          <p className="mt-1 text-[11px] text-slate-400">预留真实接入字段：sonarDistance，后续直接替换假数据来源</p>
        </div>
        <span className="rounded border border-emerald-300/30 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100">
          假数据在线
        </span>
      </div>
      <div className="max-h-48 overflow-auto rounded border border-slate-600/20">
        <table className="w-full min-w-[760px] border-collapse text-left text-[11px]">
          <thead className="sticky top-0 bg-slate-900 text-slate-300">
            <tr>
              <th className="px-2 py-2 font-medium">包号</th>
              <th className="px-2 py-2 font-medium">时间</th>
              <th className="px-2 py-2 font-medium">扫描 X</th>
              <th className="px-2 py-2 font-medium">sonarDistance</th>
              <th className="px-2 py-2 font-medium">基准距离</th>
              <th className="px-2 py-2 font-medium">距水面深度</th>
              <th className="px-2 py-2 font-medium">冲刷增量</th>
              <th className="px-2 py-2 font-medium">深坑概率</th>
              <th className="px-2 py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="border-t border-slate-700/40 text-slate-400">
                <td className="px-2 py-3" colSpan={9}>
                  等待第一帧声呐距离数据...
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.seq} className="border-t border-slate-700/40 text-slate-200">
                <td className="px-2 py-2 font-mono text-cyan-100">#{row.seq}</td>
                <td className="px-2 py-2 font-mono">{row.timestamp}</td>
                <td className="px-2 py-2 font-mono">{row.scanX.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono text-cyan-100">{row.sonarDistance.toFixed(2)} 米</td>
                <td className="px-2 py-2 font-mono">{row.baselineDistance.toFixed(2)} 米</td>
                <td className="px-2 py-2 font-mono">{row.depthFromWater.toFixed(2)} 米</td>
                <td className="px-2 py-2 font-mono text-amber-100">{row.scourDelta.toFixed(2)} 米</td>
                <td className="px-2 py-2 font-mono">{Math.round(row.pitProbability * 100)}%</td>
                <td className="px-2 py-2">{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataPanel({ telemetry, dataLog, bedMap }) {
  const modeTone =
    telemetry.mode === MODES.alarm
      ? "border-red-300/50 bg-red-400/12 text-red-100"
      : telemetry.mode === MODES.rescan
        ? "border-amber-300/50 bg-amber-400/12 text-amber-100"
        : "border-emerald-300/40 bg-emerald-400/10 text-emerald-100";

  return (
    <aside className="pointer-events-auto w-[min(540px,calc(100vw-32px))] rounded-md border border-cyan-100/15 bg-panel p-5 shadow-2xl shadow-black/40 backdrop-blur-md">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-cyan-200/70">桥载单波束实时测距</p>
          <h2 className="mt-2 text-lg font-semibold text-white">河床深坑识别</h2>
        </div>
        <div className={`rounded border px-3 py-1.5 text-xs font-semibold ${modeTone}`}>{telemetry.mode}</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Gauge className="h-4 w-4 text-cyan-200" />
            声呐返回距离 sonarDistance
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold text-cyan-100">
            {telemetry.sonarDistance.toFixed(2)}
            <span className="ml-1 text-sm text-slate-300">米</span>
          </div>
        </div>
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Activity className="h-4 w-4 text-red-200" />
            桥墩处深坑判断
          </div>
          <div className="mt-2 text-sm leading-6 text-slate-100">{telemetry.status}</div>
          <div className="mt-1 font-mono text-lg text-amber-100">+{telemetry.scourDelta.toFixed(2)} 米</div>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <MetricBar label="扫描进度" value={telemetry.scanProgress} />
        <MetricBar label="深坑概率" value={telemetry.pitProbability} tone={telemetry.pitProbability > 0.7 ? "red" : "amber"} />
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <p className="text-xs text-slate-400">采集包号</p>
          <p className="mt-2 font-mono text-lg text-cyan-100">#{telemetry.sensorSeq}</p>
        </div>
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <p className="text-xs text-slate-400">扫描位置 X</p>
          <p className="mt-2 font-mono text-lg text-cyan-100">{telemetry.scanX.toFixed(2)}</p>
        </div>
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <p className="text-xs text-slate-400">反演河床高程</p>
          <p className="mt-2 font-mono text-lg text-cyan-100">{telemetry.bedElevation.toFixed(2)}</p>
        </div>
      </div>

      <div className="mt-5 rounded border border-cyan-100/10 bg-slate-950/35 p-3 text-xs leading-6 text-slate-300">
        <div className="flex items-center gap-2 text-slate-100">
          <Radar className="h-4 w-4 text-cyan-200" />
          判别流程
        </div>
        <p className="mt-2">
          桥载单波束声呐返回距离值 sonarDistance。系统将其与该扫描位置的基准距离比较；若桥墩附近返回距离明显变大，则反演为河床下切并标记疑似深坑。
        </p>
      </div>

      <BedProfile bedMap={bedMap} />
      <SensorDataTable rows={dataLog} />
    </aside>
  );
}

function ControlButton({ onClick, active, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex h-10 items-center gap-2 rounded border px-3 text-sm font-medium transition ${
        active
          ? "border-cyan-200/55 bg-cyan-300/15 text-cyan-50 shadow-[0_0_20px_rgba(103,232,249,0.12)]"
          : "border-slate-400/20 bg-slate-950/45 text-slate-200 hover:border-cyan-200/40 hover:text-white"
      }`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

function App() {
  const [running, setRunning] = useState(true);
  const [showBeam, setShowBeam] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [dataLog, setDataLog] = useState([]);
  const [bedMap, setBedMap] = useState(new Map());

  const handleReset = () => {
    setTelemetry(initialTelemetry);
    setDataLog([]);
    setBedMap(new Map());
    setResetKey((key) => key + 1);
    setRunning(true);
  };

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#07111f]">
      <Canvas shadows camera={{ position: [6.8, 4.1, 7.7], fov: 48, near: 0.1, far: 80 }} gl={{ antialias: true, alpha: false }}>
        <SimulationScene
          running={running}
          telemetry={telemetry}
          setTelemetry={setTelemetry}
          setDataLog={setDataLog}
          bedMap={bedMap}
          setBedMap={setBedMap}
          showBeam={showBeam}
          resetKey={resetKey}
        />
      </Canvas>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_25%,rgba(49,196,230,0.16),transparent_34%),linear-gradient(180deg,rgba(7,17,31,0.08),rgba(7,17,31,0.52))]" />

      <header className="pointer-events-none absolute left-4 right-4 top-4 md:left-6 md:right-auto md:top-5">
        <div className="rounded-md border border-cyan-100/15 bg-slate-950/55 px-5 py-4 shadow-2xl shadow-black/30 backdrop-blur-md">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">桥墩冲刷概念验证系统</p>
          <h1 className="mt-2 text-lg font-semibold tracking-normal text-white sm:text-2xl">
            桥载单波束声呐测距驱动的河床深坑检测演示
          </h1>
        </div>
      </header>

      <div className="pointer-events-none absolute bottom-4 left-4 right-4 lg:bottom-5 lg:left-6 lg:right-[570px]">
        <div className="pointer-events-auto rounded-md border border-cyan-100/15 bg-slate-950/65 p-4 shadow-2xl shadow-black/35 backdrop-blur-md">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ControlButton onClick={() => setRunning((value) => !value)} active={running} icon={running ? Pause : Play}>
              {running ? "暂停" : "开始"}
            </ControlButton>
            <ControlButton onClick={handleReset} active={false} icon={RotateCcw}>
              重置
            </ControlButton>
            <ControlButton onClick={() => setShowBeam((value) => !value)} active={showBeam} icon={Radar}>
              显示/隐藏声呐波束
            </ControlButton>
          </div>

          <div className="flex items-center gap-4">
            <span className="w-24 text-xs uppercase tracking-[0.2em] text-slate-400">声呐扫描进度</span>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-slate-800">
              <div className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-cyan-300 via-amber-300 to-red-400" style={{ width: `${telemetry.scanProgress * 100}%` }} />
              <div className="absolute left-[55%] top-0 h-full w-px bg-red-100/80" />
            </div>
            <span className="w-16 text-right font-mono text-xs text-slate-300">{Math.round(telemetry.scanProgress * 100)}%</span>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute right-4 top-32 md:right-6 md:top-5">
        <DataPanel telemetry={telemetry} dataLog={dataLog} bedMap={bedMap} />
      </div>
    </main>
  );
}

export default App;
