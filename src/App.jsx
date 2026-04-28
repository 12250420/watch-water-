import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Html, Line, OrbitControls } from "@react-three/drei";
import { Activity, Gauge, Pause, Play, Radar, RotateCcw, Waves } from "lucide-react";
import * as THREE from "three";

const PIT_CENTER = new THREE.Vector3(0, -3.1, 0);
const BASE_DEPTH = 4.2;
const PIT_EXTRA_DEPTH = 2.15;
const UPDATE_RATE = 1 / 24;

const MODES = {
  patrol: "巡检",
  anomaly: "异常检测",
  confirm: "单波束确认",
};

const initialTelemetry = {
  time: 0,
  progress: 0,
  boatPosition: [-6.2, -0.08, 0.15],
  boatRotation: 0,
  whiskerSignal: { left: 0.22, center: 0.25, right: 0.2 },
  confidence: 0.12,
  sonarDepth: BASE_DEPTH,
  mode: MODES.patrol,
  nearPit: false,
  beamActive: false,
  sensorSeq: 0,
  sonarStatus: "待机",
  bridgeSonarPosition: [-3.85, 0.48, 0.02],
  flowVelocity: 0.42,
  turbulence: 0.18,
  sediment: 0.22,
};

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothPulse(distance, radius = 2.2) {
  return Math.exp(-(distance * distance) / (2 * radius * radius));
}

function fixedInspectionPose(progress) {
  const x = THREE.MathUtils.lerp(-6.2, 4.4, progress);
  const z = 0.15 + 0.22 * Math.sin(progress * Math.PI);
  const dx = 10.6;
  const dz = 0.22 * Math.PI * Math.cos(progress * Math.PI);
  return {
    position: new THREE.Vector3(x, -0.08, z),
    rotationY: Math.atan2(dx, dz),
  };
}

function calculateWhiskerSignal(position, elapsed) {
  const offsets = {
    left: new THREE.Vector3(-0.58, 0, 0.2),
    center: new THREE.Vector3(0, 0, 0.35),
    right: new THREE.Vector3(0.58, 0, 0.2),
  };

  const signalFor = (offset, phase) => {
    const probe = position.clone().add(offset);
    const distance = Math.hypot(probe.x - PIT_CENTER.x, probe.z - PIT_CENTER.z);
    const anomaly = smoothPulse(distance, 1.55);
    const flowNoise = 0.035 * Math.sin(elapsed * 2.8 + phase);
    return clamp01(0.18 + anomaly * 0.78 + flowNoise);
  };

  return {
    left: signalFor(offsets.left, 0.2),
    center: signalFor(offsets.center, 1.6),
    right: signalFor(offsets.right, 2.7),
  };
}

function createInitialFlowState() {
  return {
    flowVelocity: 0.42,
    turbulence: 0.18,
    sediment: 0.22,
    anomalyBias: 0.08,
    anomalyTarget: 0.12,
    nextTargetAt: 9.0,
    forcedEventDone: false,
    probeX: -2.8,
    probeZ: 1.05,
  };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function updateFlowState(state, elapsed, trackProgress) {
  if (elapsed >= state.nextTargetAt) {
    const abnormalEvent = !state.forcedEventDone || Math.random() > 0.58;
    state.anomalyTarget = abnormalEvent ? randomBetween(0.62, 0.96) : randomBetween(0.03, 0.26);
    state.forcedEventDone = true;
    state.nextTargetAt = elapsed + randomBetween(4.2, 8.5);
  }

  state.flowVelocity = clamp01(state.flowVelocity + (Math.random() - 0.49) * 0.035);
  state.turbulence = clamp01(state.turbulence * 0.92 + (0.08 + state.flowVelocity * 0.32 + Math.random() * 0.16) * 0.08);
  state.sediment = clamp01(state.sediment * 0.9 + (0.1 + state.anomalyBias * 0.58 + Math.random() * 0.24) * 0.1);
  state.anomalyBias = clamp01(state.anomalyBias * 0.94 + state.anomalyTarget * 0.06 + (Math.random() - 0.5) * 0.025);
  const nearPierTrack = Math.exp(-((trackProgress - 0.58) ** 2) / (2 * 0.13 * 0.13));
  state.anomalyBias = clamp01(state.anomalyBias + nearPierTrack * 0.006);

  return state;
}

function calculateWhiskerSignalFromFlow(flowState) {
  const common = 0.12 + flowState.turbulence * 0.35 + flowState.anomalyBias * 0.58;
  const lateralShear = (Math.random() - 0.5) * (0.1 + flowState.turbulence * 0.16);
  return {
    left: clamp01(common + lateralShear + (Math.random() - 0.5) * 0.04),
    center: clamp01(common + flowState.anomalyBias * 0.14 + (Math.random() - 0.5) * 0.035),
    right: clamp01(common - lateralShear + (Math.random() - 0.5) * 0.04),
  };
}

function calculateSonarDepthFromFlow(flowState) {
  const scourInfluence = clamp01((flowState.anomalyBias - 0.26) / 0.62);
  const bedNoise = (Math.random() - 0.5) * 0.16 + flowState.sediment * 0.08;
  return BASE_DEPTH + PIT_EXTRA_DEPTH * scourInfluence + bedNoise;
}

function calculateSonarDepth(position) {
  const distance = Math.hypot(position.x - PIT_CENTER.x, position.z - PIT_CENTER.z);
  const pitInfluence = smoothPulse(distance, 1.28);
  const bedRipple = 0.15 * Math.sin(position.x * 0.9) + 0.1 * Math.cos(position.z * 1.4);
  return BASE_DEPTH + PIT_EXTRA_DEPTH * pitInfluence + bedRipple;
}

function resolveMode(confidence, sonarDepth) {
  if (confidence > 0.72 && sonarDepth > BASE_DEPTH + 1.05) return MODES.confirm;
  if (confidence > 0.5) return MODES.anomaly;
  return MODES.patrol;
}

function calculateBridgeSonarPosition(confidence) {
  const moveRatio = clamp01((confidence - 0.22) / 0.58);
  const eased = moveRatio * moveRatio * (3 - 2 * moveRatio);
  return [THREE.MathUtils.lerp(-3.85, PIT_CENTER.x + 0.05, eased), 0.48, 0.02];
}

function buildSensorPacket({ seq, time, pose, whiskerSignal, confidence, sonarDepth, mode, beamActive, bridgeSonarPosition, flowState }) {
  return {
    seq,
    timestamp: `T+${time.toFixed(1)}s`,
    whiskerLeft: whiskerSignal.left,
    whiskerCenter: whiskerSignal.center,
    whiskerRight: whiskerSignal.right,
    confidence,
    sonarDepth,
    mode,
    sonarStatus: beamActive ? "扫描确认" : confidence > 0.5 ? "移动定位" : "待机",
    bridgeSonarX: bridgeSonarPosition[0],
    platformX: pose.position.x,
    platformZ: pose.position.z,
    flowVelocity: flowState.flowVelocity,
    turbulence: flowState.turbulence,
    sediment: flowState.sediment,
  };
}

function bedYAt(x, z) {
  const distance = Math.hypot(x - PIT_CENTER.x, z - PIT_CENTER.z);
  const pit = Math.exp(-(distance * distance) / (2 * 1.35 * 1.35));
  const ripple = 0.14 * Math.sin(x * 1.2) * Math.cos(z * 1.6);
  return -BASE_DEPTH - ripple - PIT_EXTRA_DEPTH * pit;
}

function Riverbed() {
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
      const distance = Math.hypot(x - PIT_CENTER.x, z - PIT_CENTER.z);
      const pit = Math.exp(-(distance * distance) / (2 * 1.35 * 1.35));
      const shoal = Math.exp(-((x + 2.2) ** 2 + (z - 1.3) ** 2) / (2 * 1.75 * 1.75));
      const dune = 0.1 * Math.sin(x * 2.4 + z * 0.5) + 0.055 * Math.sin(z * 4.2);
      position.setY(i, bedYAt(x, z) + shoal * 0.32 + dune);

      color.setHSL(0.09 + pit * 0.015, 0.34 + shoal * 0.16 + pit * 0.14, 0.35 - pit * 0.11 + shoal * 0.06);
      colors.push(color.r, color.g, color.b);
    }

    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }, []);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.9} metalness={0.03} />
    </mesh>
  );
}

function BedSediment() {
  const grains = useMemo(
    () =>
      Array.from({ length: 110 }, (_, index) => {
        const x = -7.3 + Math.random() * 14.6;
        const z = -5.2 + Math.random() * 10.4;
        const pitDistance = Math.hypot(x - PIT_CENTER.x, z - PIT_CENTER.z);
        return {
          key: index,
          position: [x, bedYAt(x, z) + 0.06 + Math.random() * 0.05, z],
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

function SuspendedSediment({ active, telemetry }) {
  const particles = useMemo(
    () =>
      Array.from({ length: 52 }, (_, index) => ({
        key: index,
        radius: 0.25 + Math.random() * 1.05,
        angle: Math.random() * Math.PI * 2,
        y: -3.95 + Math.random() * 1.0,
        size: 0.025 + Math.random() * 0.04,
      })),
    [],
  );

  return (
    <group visible={active} position={[PIT_CENTER.x, 0, PIT_CENTER.z]} rotation={[0, telemetry.sediment * Math.PI, 0]}>
      {particles.map((particle) => (
        <mesh
          key={particle.key}
          position={[
            Math.cos(particle.angle) * particle.radius,
            particle.y,
            Math.sin(particle.angle) * particle.radius,
          ]}
          scale={particle.size * (0.75 + telemetry.sediment)}
        >
          <sphereGeometry args={[1, 8, 6]} />
          <meshBasicMaterial color="#d4a468" transparent opacity={0.18 + telemetry.sediment * 0.34} />
        </mesh>
      ))}
    </group>
  );
}

function WaterSurface({ telemetry }) {
  return (
    <group>
      <mesh position={[0, -0.35, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[18, 13, 1, 1]} />
        <meshStandardMaterial
          color="#58c7e6"
          transparent
          opacity={0.22 + telemetry.flowVelocity * 0.14}
          roughness={0.18}
          metalness={0.05}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function FlowArrow({ x, z, flowVelocity = 0.42, turbulence = 0.18, color = "#7ad8ff" }) {
  return (
    <group position={[x + turbulence * 0.18, -0.52, z]} rotation={[0, Math.PI / 2, 0]} scale={[1, 0.72 + flowVelocity * 0.82, 1]}>
      <mesh>
        <cylinderGeometry args={[0.018, 0.018, 1.45, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.42 + flowVelocity * 0.42} />
      </mesh>
    </group>
  );
}

function FlowField({ telemetry }) {
  const mainFlow = useMemo(
    () =>
      Array.from({ length: 4 }, (_, i) => ({
        x: -5.8 + i * 3.1,
        z: -4.4 + (i % 2) * 1.25,
        phase: i * 0.7,
      })),
    [],
  );

  return (
    <group>
      {mainFlow.map((arrow) => (
        <FlowArrow
          key={`${arrow.x}-${arrow.z}`}
          {...arrow}
          flowVelocity={telemetry.flowVelocity}
          turbulence={telemetry.turbulence}
        />
      ))}
      <Line
        points={[
          [0.15, -0.16, -0.65],
          [0.05, -0.22, -0.95],
          [0.25, -0.22, -1.25],
          [0.55, -0.22, -1.12],
          [0.55, -0.22, -0.82],
        ]}
        color="#ff9f66"
        lineWidth={2}
        transparent
        opacity={0.75}
      />
      <Line
        points={[
          [1.62, -0.16, 1.28],
          [1.78, -0.22, 1.55],
          [1.56, -0.22, 1.82],
          [1.18, -0.22, 1.74],
          [1.17, -0.22, 1.39],
        ]}
        color="#ff9f66"
        lineWidth={2}
        transparent
        opacity={0.72}
      />
    </group>
  );
}

function InspectionTrack() {
  const points = useMemo(
    () =>
      Array.from({ length: 36 }, (_, index) => {
        const progress = index / 35;
        const pose = fixedInspectionPose(progress);
        return [pose.position.x, pose.position.y - 0.03, pose.position.z];
      }),
    [],
  );

  return (
    <group>
      <Line points={points} color="#facc15" lineWidth={2} transparent opacity={0.68} />
    </group>
  );
}

function SceneLegend({ telemetry }) {
  return (
    <Html position={[-6.15, 1.55, 3.35]} center>
      <div className="w-60 rounded border border-cyan-100/20 bg-slate-950/70 p-3 text-xs leading-6 text-slate-200 shadow-2xl backdrop-blur">
        <div className="mb-1 font-semibold text-cyan-100">场景要素</div>
        <div>桥面 / 横梁 / 主桥墩</div>
        <div>半透明低水位水面</div>
        <div>黄色线：触须平台固定循环测线</div>
        <div>蓝色短线：主流方向，强度随数据变化</div>
        <div>红色圆环：可疑冲刷坑区域</div>
        <div className="mt-1 text-amber-100">
          当前水流 {Math.round(telemetry.flowVelocity * 100)}% / 湍动 {Math.round(telemetry.turbulence * 100)}%
        </div>
        <div className="text-cyan-100">系统状态：{telemetry.mode} / {telemetry.sonarStatus}</div>
      </div>
    </Html>
  );
}

function BridgePier() {
  return (
    <group>
      <mesh position={[0.9, 0.94, 0.55]} castShadow receiveShadow>
        <boxGeometry args={[14.8, 0.32, 2.05]} />
        <meshStandardMaterial color="#9fa8b2" roughness={0.58} metalness={0.06} />
      </mesh>
      <mesh position={[0.9, 1.18, 0.55]} castShadow receiveShadow>
        <boxGeometry args={[14.35, 0.12, 1.78]} />
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
            <boxGeometry args={[14.45, 0.08, 0.08]} />
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
      {[-6.35, 6.95].map((x) => (
        <mesh key={`side-pier-${x}`} position={[x, -1.95, 0.55]} castShadow receiveShadow>
          <cylinderGeometry args={[0.42, 0.52, 4.9, 48]} />
          <meshStandardMaterial color="#89919a" roughness={0.66} metalness={0.06} />
        </mesh>
      ))}
      <mesh position={[0.9, -2.1, 0.55]} castShadow receiveShadow>
        <cylinderGeometry args={[0.62, 0.82, 5.2, 64]} />
        <meshStandardMaterial color="#a6adb4" roughness={0.62} metalness={0.08} />
      </mesh>
      <mesh position={[0.9, -4.74, 0.55]} receiveShadow>
        <cylinderGeometry args={[1.08, 1.25, 0.34, 64]} />
        <meshStandardMaterial color="#6d7378" roughness={0.74} />
      </mesh>
      <mesh position={[0.9, -0.16, 0.55]} receiveShadow>
        <torusGeometry args={[0.9, 0.035, 12, 80]} />
        <meshBasicMaterial color="#bfefff" transparent opacity={0.28} />
      </mesh>
    </group>
  );
}

function ScourMarker({ active }) {
  return (
    <group position={[PIT_CENTER.x, -4.32, PIT_CENTER.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.08, 1.35, 80]} />
        <meshBasicMaterial
          color={active ? "#ff3f56" : "#b93a44"}
          transparent
          opacity={active ? 0.56 : 0.26}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.08, 80]} />
        <meshBasicMaterial color="#ff3048" transparent opacity={active ? 0.18 : 0.08} />
      </mesh>
    </group>
  );
}

function WhiskerTube({ offsetX, signal, phase, visible }) {
  const curve = useMemo(() => {
    const amp = 0.08 + signal * 0.26;
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(offsetX, -0.16, 0.1),
      new THREE.Vector3(offsetX + Math.sin(phase) * amp, -0.78, 0.18),
      new THREE.Vector3(offsetX + Math.sin(phase + 0.8) * amp * 1.3, -1.34, 0.28),
      new THREE.Vector3(offsetX + Math.sin(phase + 1.4) * amp * 1.55, -1.9, 0.36),
    ]);
  }, [offsetX, signal, phase]);

  const color = useMemo(() => {
    const c = new THREE.Color();
    c.setHSL(0.48 - signal * 0.12, 0.88, 0.42 + signal * 0.36);
    return c;
  }, [signal]);

  if (!visible) return null;

  return (
    <mesh castShadow>
      <tubeGeometry args={[curve, 22, 0.035, 10, false]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={signal * 0.65} />
    </mesh>
  );
}

function SonarBeam({ depth, active, visible }) {
  if (!visible || !active) return null;

  return (
    <group>
      <mesh position={[0, -depth / 2, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[Math.max(0.54, depth * 0.18), depth, 48, 1, true]} />
        <meshBasicMaterial color="#45d7ff" transparent opacity={0.24} side={THREE.DoubleSide} />
      </mesh>
      <Line
        points={[
          [0, 0, 0],
          [0, -depth, 0],
        ]}
        color="#d8fbff"
        lineWidth={1.5}
        transparent
        opacity={0.85}
      />
      <mesh position={[0, -depth, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.22, 0.34, 40]} />
        <meshBasicMaterial color="#c9fbff" transparent opacity={0.86} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function BridgeMountedSonar({ telemetry, showBeam }) {
  const { sonarDepth, beamActive, bridgeSonarPosition } = telemetry;
  const [sonarX, sonarY, sonarZ] = bridgeSonarPosition;
  const beamLength = sonarDepth + sonarY;

  return (
    <group>
      <Line
        points={[
          [-4.35, sonarY + 0.08, sonarZ],
          [1.1, sonarY + 0.08, sonarZ],
        ]}
        color="#d8e5ef"
        lineWidth={2}
        transparent
        opacity={0.72}
      />
      <group position={[sonarX, sonarY, sonarZ]}>
        <mesh castShadow>
          <boxGeometry args={[0.64, 0.22, 0.42]} />
          <meshStandardMaterial color="#1e3145" roughness={0.42} metalness={0.18} />
        </mesh>
        <mesh position={[0, -0.2, 0]} castShadow>
          <cylinderGeometry args={[0.13, 0.13, 0.3, 24]} />
          <meshStandardMaterial
            color="#20e6ff"
            emissive="#0a8ba0"
            emissiveIntensity={beamActive ? 0.9 : 0.28}
          />
        </mesh>
        <Line
          points={[
            [0, 0.26, 0],
            [0, 0.72, 0],
          ]}
          color="#c9d7e2"
          lineWidth={1.4}
          transparent
          opacity={0.72}
        />
        <SonarBeam depth={beamLength} active={beamActive} visible={showBeam} />
      </group>
    </group>
  );
}

function Boat({ telemetry, showWhiskers }) {
  const { boatPosition, boatRotation, whiskerSignal, turbulence } = telemetry;

  return (
    <group position={boatPosition} rotation={[0, boatRotation, 0]}>
      <mesh position={[0, 0.08, 0]} castShadow>
        <boxGeometry args={[1.45, 0.22, 0.82]} />
        <meshStandardMaterial color="#f0f5f7" roughness={0.38} metalness={0.08} />
      </mesh>
      <mesh position={[0, 0.23, -0.08]} castShadow>
        <boxGeometry args={[0.82, 0.22, 0.42]} />
        <meshStandardMaterial color="#22364a" roughness={0.42} metalness={0.18} />
      </mesh>
      <mesh position={[0, -0.05, 0.26]} castShadow>
        <boxGeometry args={[0.34, 0.08, 0.22]} />
        <meshStandardMaterial color="#67e8f9" emissive="#0a8ba0" emissiveIntensity={0.16} />
      </mesh>
      <WhiskerTube
        offsetX={-0.44}
        signal={whiskerSignal.left}
        phase={whiskerSignal.left * 7 + turbulence * 3}
        visible={showWhiskers}
      />
      <WhiskerTube
        offsetX={0}
        signal={whiskerSignal.center}
        phase={whiskerSignal.center * 7 + turbulence * 4 + 0.9}
        visible={showWhiskers}
      />
      <WhiskerTube
        offsetX={0.44}
        signal={whiskerSignal.right}
        phase={whiskerSignal.right * 7 + turbulence * 3.4 + 1.7}
        visible={showWhiskers}
      />
    </group>
  );
}

function StatusLabels({ telemetry }) {
  const confirmed = telemetry.mode === MODES.confirm;
  const abnormal = telemetry.mode !== MODES.patrol;

  return (
    <>
      {abnormal && (
        <Html position={[PIT_CENTER.x - 1.6, -1.0, PIT_CENTER.z - 1.05]} center>
          <div className="whitespace-nowrap rounded border border-red-300/45 bg-red-950/70 px-3 py-2 text-xs font-semibold tracking-[0.16em] text-red-100 shadow-2xl shadow-red-950/50 backdrop-blur">
            检测到异常流场
          </div>
        </Html>
      )}
      {confirmed && (
        <Html position={[PIT_CENTER.x - 1.25, -3.65, PIT_CENTER.z + 1.55]} center>
          <div className="whitespace-nowrap rounded border border-cyan-200/50 bg-cyan-950/75 px-3 py-2 text-xs font-semibold tracking-[0.12em] text-cyan-50 shadow-xl backdrop-blur">
            测深 {telemetry.sonarDepth.toFixed(2)} 米 | 疑似冲刷坑已确认
          </div>
        </Html>
      )}
    </>
  );
}

function SimulationScene({ running, telemetry, setTelemetry, setDataLog, showBeam, showWhiskers, resetKey }) {
  const simRef = useRef({
    time: 0,
    trackProgress: 0,
    accumulator: 0,
    logAccumulator: 0,
    seq: 0,
    flowState: createInitialFlowState(),
    resetKey,
  });

  useFrame((_, delta) => {
    if (simRef.current.resetKey !== resetKey) {
      simRef.current = {
        time: 0,
        trackProgress: 0,
        accumulator: 0,
        logAccumulator: 0,
        seq: 0,
        flowState: createInitialFlowState(),
        resetKey,
      };
      setTelemetry(initialTelemetry);
      setDataLog([]);
      return;
    }

    if (!running) return;

    const sim = simRef.current;
    sim.time += delta;
    sim.trackProgress = (sim.trackProgress + delta * 0.045) % 1;
    sim.accumulator += delta;
    sim.logAccumulator += delta;

    if (sim.accumulator < UPDATE_RATE) return;
    sim.accumulator = 0;

    const flowState = updateFlowState(sim.flowState, sim.time, sim.trackProgress);
    const pose = fixedInspectionPose(sim.trackProgress);
    const whiskerSignal = calculateWhiskerSignalFromFlow(flowState);
    const maxSignal = Math.max(whiskerSignal.left, whiskerSignal.center, whiskerSignal.right);
    const confidence = clamp01(0.08 + maxSignal * 0.78 + flowState.sediment * 0.14);
    const sonarDepth = calculateSonarDepthFromFlow(flowState);
    const mode = resolveMode(confidence, sonarDepth);
    const beamActive = mode === MODES.confirm;
    const bridgeSonarPosition = calculateBridgeSonarPosition(confidence);
    sim.seq += 1;

    const packet = buildSensorPacket({
      seq: sim.seq,
      time: sim.time,
      pose,
      whiskerSignal,
      confidence,
      sonarDepth,
      mode,
      beamActive,
      bridgeSonarPosition,
      flowState,
    });

    setTelemetry({
      time: sim.time,
      progress: sim.trackProgress,
      boatPosition: pose.position.toArray(),
      boatRotation: pose.rotationY,
      whiskerSignal,
      confidence,
      sonarDepth,
      mode,
      nearPit: confidence > 0.5,
      beamActive,
      sensorSeq: packet.seq,
      sonarStatus: packet.sonarStatus,
      bridgeSonarPosition,
      flowVelocity: packet.flowVelocity,
      turbulence: packet.turbulence,
      sediment: packet.sediment,
    });

    if (sim.logAccumulator >= 0.18) {
      sim.logAccumulator = 0;
      setDataLog((rows) => [packet, ...rows].slice(0, 12));
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
      <WaterSurface telemetry={telemetry} />
      <Riverbed />
      <BedSediment />
      <BridgePier />
      <ScourMarker active={telemetry.nearPit} />
      <SuspendedSediment active={telemetry.nearPit} telemetry={telemetry} />
      <FlowField telemetry={telemetry} />
      <InspectionTrack />
      <SceneLegend telemetry={telemetry} />
      <BridgeMountedSonar telemetry={telemetry} showBeam={showBeam} />
      <Boat telemetry={telemetry} showWhiskers={showWhiskers} />
      <ContactShadows position={[0, -4.38, 0]} opacity={0.45} scale={13} blur={2} far={4} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={5}
        maxDistance={14}
        maxPolarAngle={Math.PI * 0.49}
        target={[0, -2.1, 0]}
      />
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

function SensorDataTable({ rows }) {
  return (
    <div className="mt-5 rounded border border-cyan-100/10 bg-slate-950/40 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-100">实时传感器数据流</p>
          <p className="mt-1 text-[11px] text-slate-400">最近 12 帧模拟采集包，动画由这些字段驱动</p>
        </div>
        <span className="rounded border border-emerald-300/30 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-100">
          模拟在线
        </span>
      </div>
      <div className="max-h-48 overflow-auto rounded border border-slate-600/20">
        <table className="w-full min-w-[820px] border-collapse text-left text-[11px]">
          <thead className="sticky top-0 bg-slate-900 text-slate-300">
            <tr>
              <th className="px-2 py-2 font-medium">包号</th>
              <th className="px-2 py-2 font-medium">时间</th>
              <th className="px-2 py-2 font-medium">左触须</th>
              <th className="px-2 py-2 font-medium">中触须</th>
              <th className="px-2 py-2 font-medium">右触须</th>
              <th className="px-2 py-2 font-medium">异常概率</th>
              <th className="px-2 py-2 font-medium">水流速度</th>
              <th className="px-2 py-2 font-medium">湍动强度</th>
              <th className="px-2 py-2 font-medium">含沙扰动</th>
              <th className="px-2 py-2 font-medium">声呐深度</th>
              <th className="px-2 py-2 font-medium">声呐状态</th>
              <th className="px-2 py-2 font-medium">模式</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className="border-t border-slate-700/40 text-slate-400">
                <td className="px-2 py-3" colSpan={12}>
                  等待第一帧传感器数据...
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.seq} className="border-t border-slate-700/40 text-slate-200">
                <td className="px-2 py-2 font-mono text-cyan-100">#{row.seq}</td>
                <td className="px-2 py-2 font-mono">{row.timestamp}</td>
                <td className="px-2 py-2 font-mono">{row.whiskerLeft.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono">{row.whiskerCenter.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono">{row.whiskerRight.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono text-amber-100">{Math.round(row.confidence * 100)}%</td>
                <td className="px-2 py-2 font-mono">{row.flowVelocity.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono">{row.turbulence.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono">{row.sediment.toFixed(2)}</td>
                <td className="px-2 py-2 font-mono text-cyan-100">{row.sonarDepth.toFixed(2)}米</td>
                <td className="px-2 py-2">{row.sonarStatus}</td>
                <td className="px-2 py-2">{row.mode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataPanel({ telemetry, dataLog }) {
  const modeTone =
    telemetry.mode === MODES.confirm
      ? "border-cyan-300/50 bg-cyan-400/12 text-cyan-100"
      : telemetry.mode === MODES.anomaly
        ? "border-red-300/50 bg-red-400/12 text-red-100"
        : "border-emerald-300/40 bg-emerald-400/10 text-emerald-100";

  return (
    <aside className="pointer-events-auto w-[min(520px,calc(100vw-32px))] rounded-md border border-cyan-100/15 bg-panel p-5 shadow-2xl shadow-black/40 backdrop-blur-md">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-cyan-200/70">实时监测数据</p>
          <h2 className="mt-2 text-lg font-semibold text-white">冲刷异常识别链路</h2>
        </div>
        <div className={`rounded border px-3 py-1.5 text-xs font-semibold ${modeTone}`}>{telemetry.mode}</div>
      </div>

      <div className="space-y-4">
        <MetricBar label="左触须信号" value={telemetry.whiskerSignal.left} />
        <MetricBar label="中触须信号" value={telemetry.whiskerSignal.center} />
        <MetricBar label="右触须信号" value={telemetry.whiskerSignal.right} />
        <MetricBar label="异常概率" value={telemetry.confidence} tone={telemetry.confidence > 0.55 ? "red" : "amber"} />
        <MetricBar label="水流速度模拟值" value={telemetry.flowVelocity} />
        <MetricBar label="湍动强度模拟值" value={telemetry.turbulence} tone="amber" />
        <MetricBar label="含沙扰动模拟值" value={telemetry.sediment} tone="amber" />
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <p className="text-xs text-slate-400">采集包号</p>
          <p className="mt-2 font-mono text-lg text-cyan-100">#{telemetry.sensorSeq}</p>
        </div>
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <p className="text-xs text-slate-400">声呐状态</p>
          <p className="mt-2 text-sm text-slate-100">{telemetry.sonarStatus}</p>
        </div>
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <p className="text-xs text-slate-400">桥载声呐 X</p>
          <p className="mt-2 font-mono text-lg text-cyan-100">{telemetry.bridgeSonarPosition[0].toFixed(2)}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Gauge className="h-4 w-4 text-cyan-200" />
            桥载单波束测深
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-cyan-100">
            {telemetry.sonarDepth.toFixed(2)}
            <span className="ml-1 text-sm text-slate-300">米</span>
          </div>
        </div>
        <div className="rounded border border-slate-500/25 bg-slate-950/35 p-3">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Activity className="h-4 w-4 text-red-200" />
            当前判断
          </div>
          <div className="mt-2 text-sm leading-6 text-slate-100">
            {telemetry.mode === MODES.patrol && "触须阵列低扰动"}
            {telemetry.mode === MODES.anomaly && "触须异常预警"}
            {telemetry.mode === MODES.confirm && "桥载声呐定点复核"}
          </div>
        </div>
      </div>

      <div className="mt-5 rounded border border-cyan-100/10 bg-slate-950/35 p-3 text-xs leading-6 text-slate-300">
        <div className="flex items-center gap-2 text-slate-100">
          <Radar className="h-4 w-4 text-cyan-200" />
          判别流程
        </div>
        <p className="mt-2">
          仿生触须阵列先感知桥墩附近异常扰动；当异常概率升高后，桥上的单波束扫描小车移动到可疑桥墩上方，再向下测深确认局部深度突增。
        </p>
      </div>

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
  const [showWhiskers, setShowWhiskers] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [dataLog, setDataLog] = useState([]);

  const handleReset = () => {
    setTelemetry(initialTelemetry);
    setDataLog([]);
    setResetKey((key) => key + 1);
    setRunning(true);
  };

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#07111f]">
      <Canvas
        shadows
        camera={{ position: [6.5, 4.1, 7.5], fov: 48, near: 0.1, far: 80 }}
        gl={{ antialias: true, alpha: false }}
      >
        <SimulationScene
          running={running}
          telemetry={telemetry}
          setTelemetry={setTelemetry}
          setDataLog={setDataLog}
          showBeam={showBeam}
          showWhiskers={showWhiskers}
          resetKey={resetKey}
        />
      </Canvas>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_25%,rgba(49,196,230,0.16),transparent_34%),linear-gradient(180deg,rgba(7,17,31,0.08),rgba(7,17,31,0.52))]" />

      <header className="pointer-events-none absolute left-4 right-4 top-4 md:left-6 md:right-auto md:top-5">
        <div className="rounded-md border border-cyan-100/15 bg-slate-950/55 px-5 py-4 shadow-2xl shadow-black/30 backdrop-blur-md">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/70">桥墩冲刷概念验证系统</p>
          <h1 className="mt-2 text-lg font-semibold tracking-normal text-white sm:text-2xl">
            仿生触须阵列 + 桥载单波束测深冲刷异常检测演示
          </h1>
        </div>
      </header>

      <div className="pointer-events-none absolute bottom-4 left-4 right-4 lg:bottom-5 lg:left-6 lg:right-[550px]">
        <div className="pointer-events-auto rounded-md border border-cyan-100/15 bg-slate-950/65 p-4 shadow-2xl shadow-black/35 backdrop-blur-md">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ControlButton onClick={() => setRunning((value) => !value)} active={running} icon={running ? Pause : Play}>
              {running ? "暂停" : "开始"}
            </ControlButton>
            <ControlButton onClick={handleReset} active={false} icon={RotateCcw}>
              重置
            </ControlButton>
            <ControlButton onClick={() => setShowBeam((value) => !value)} active={showBeam} icon={Radar}>
              显示/隐藏桥载声束
            </ControlButton>
            <ControlButton onClick={() => setShowWhiskers((value) => !value)} active={showWhiskers} icon={Waves}>
              显示/隐藏触须
            </ControlButton>
          </div>

          <div className="flex items-center gap-4">
            <span className="w-24 text-xs uppercase tracking-[0.2em] text-slate-400">触须测线进度</span>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-slate-800">
              <div
                className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-cyan-300 via-amber-300 to-red-400"
                style={{ width: `${telemetry.progress * 100}%` }}
              />
              <div className="absolute left-[50%] top-0 h-full w-px bg-red-100/80" />
            </div>
            <span className="w-16 text-right font-mono text-xs text-slate-300">
              {Math.round(telemetry.progress * 100)}%
            </span>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute right-4 top-32 md:right-6 md:top-5">
        <DataPanel telemetry={telemetry} dataLog={dataLog} />
      </div>
    </main>
  );
}

export default App;
