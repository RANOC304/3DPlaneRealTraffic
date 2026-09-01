'use client';

import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls, PointerLockControls, Stars, useTexture } from '@react-three/drei';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleHelp,
  Crosshair,
  Filter,
  Gauge,
  Globe2,
  LocateFixed,
  Maximize2,
  MousePointer2,
  Navigation,
  Plane,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

type Aircraft = {
  id: string;
  callsign: string;
  country: string;
  lat: number;
  lon: number;
  altitude: number;
  geoAltitude: number | null;
  onGround: boolean;
  speed: number;
  heading: number;
  verticalRate: number;
  lastContact: number;
  squawk: string | null;
  spi: boolean;
  positionSource: number;
  category: number;
};

type FeedResponse = {
  source: 'opensky';
  mode: 'anonymous' | 'authenticated';
  sourceTimestamp: number;
  receivedAt: number;
  refreshAfter: number;
  count: number;
  aircraft: Aircraft[];
};

type FeedState = 'connecting' | 'live' | 'preview';
type FlightStateFilter = 'airborne' | 'ground' | 'all';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const preciseNowSeconds = () => Date.now() / 1000;
const formatNumber = (value: number) => Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const previewFlights: Aircraft[] = [
  ['4ca7b3', 'RYR8VX', 'Ireland', 51.47, -0.45, 10668, 231, 112, 4, 3],
  ['a2b8f4', 'UAL923', 'United States', 48.1, -18.2, 11582, 249, 71, 0, 5],
  ['3c65a8', 'DLH441', 'Germany', 52.1, 9.9, 10120, 219, 94, -2, 3],
  ['896318', 'UAE2', 'United Arab Emirates', 41.6, 27.2, 11887, 252, 298, 1, 5],
  ['780a12', 'CPA255', 'Hong Kong', 37.9, 72.4, 10972, 243, 285, 0, 5],
  ['ab3f12', 'AAL100', 'United States', 41.1, -57.2, 11278, 246, 82, -1, 5],
  ['7c6b2a', 'QFA9', 'Australia', -12.5, 112.6, 12192, 257, 301, 0, 5],
  ['e48b21', 'TAM8084', 'Brazil', -18.4, -35.7, 10363, 235, 42, 2, 3],
  ['008a2d', 'SAA204', 'South Africa', -28.2, 27.6, 11430, 248, 214, -1, 5],
  ['86d8a1', 'ANA215', 'Japan', 39.5, 143.1, 9753, 225, 71, 2, 3],
  ['02018c', 'RAM201', 'Morocco', 36.2, -9.8, 8847, 207, 194, -2, 3],
  ['c81f21', 'ANZ1', 'New Zealand', -31.4, 169.8, 11980, 251, 224, 0, 5],
  ['400ae2', 'BAW17', 'United Kingdom', 56.1, -31.2, 11010, 239, 264, 1, 5],
  ['7502a1', 'MAS4', 'Malaysia', 17.3, 86.4, 10820, 242, 310, -1, 5],
  ['06a1e3', 'QTR739', 'Qatar', 28.7, 54.1, 11630, 250, 288, 0, 5],
  ['3446d1', 'IBE6251', 'Spain', 33.4, -22.8, 10240, 234, 251, 2, 3],
] .map(([id, callsign, country, lat, lon, altitude, speed, heading, verticalRate, category]) => ({
  id: id as string,
  callsign: callsign as string,
  country: country as string,
  lat: lat as number,
  lon: lon as number,
  altitude: altitude as number,
  geoAltitude: altitude as number,
  onGround: false,
  speed: speed as number,
  heading: heading as number,
  verticalRate: verticalRate as number,
  lastContact: nowSeconds(),
  squawk: null,
  spi: false,
  positionSource: 0,
  category: category as number,
}));

const categoryLabels: Record<number, string> = {
  0: 'No category',
  1: 'No ADS-B category',
  2: 'Light aircraft',
  3: 'Small aircraft',
  4: 'Large aircraft',
  5: 'High-vortex aircraft',
  6: 'Heavy aircraft',
  7: 'High performance',
  8: 'Rotorcraft',
  9: 'Glider / sailplane',
  10: 'Lighter-than-air',
  11: 'Parachutist',
  12: 'Ultralight',
  14: 'Unmanned aircraft',
  15: 'Space vehicle',
  16: 'Emergency vehicle',
  17: 'Service vehicle',
  18: 'Ground obstruction',
};

const sourceLabels = ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'];
const earthRadius = 2.4;
const earthKilometers = 6371;
const upVector = new Vector3(0, 1, 0);

function predictCoordinates(flight: Aircraft, timestamp: number, extraSeconds = 0) {
  if (flight.onGround || flight.speed <= 0) return { lat: flight.lat, lon: flight.lon };

  const seconds = predictionSeconds(flight, timestamp, extraSeconds);
  const angularDistance = (flight.speed * seconds) / 1000 / earthKilometers;
  const heading = flight.heading * (Math.PI / 180);
  const latitude = flight.lat * (Math.PI / 180);
  const safeCos = Math.max(0.08, Math.abs(Math.cos(latitude)));
  const lat = flight.lat + angularDistance * Math.cos(heading) * (180 / Math.PI);
  const lon = flight.lon + (angularDistance * Math.sin(heading) * (180 / Math.PI)) / safeCos;
  return { lat: Math.max(-89.9, Math.min(89.9, lat)), lon: ((lon + 540) % 360) - 180 };
}

function predictionSeconds(flight: Aircraft, timestamp: number, extraSeconds = 0) {
  return Math.max(-900, Math.min(900, timestamp - flight.lastContact + extraSeconds));
}

function globePosition(
  flight: Aircraft,
  timestamp: number,
  predictive: boolean,
  extraSeconds = 0,
  target = new Vector3(),
) {
  const coords = predictive
    ? predictCoordinates(flight, timestamp, extraSeconds)
    : { lat: flight.lat, lon: flight.lon };
  const projectedAltitude = predictive
    ? Math.max(0, flight.altitude + flight.verticalRate * predictionSeconds(flight, timestamp, extraSeconds))
    : flight.altitude;
  const altitudeOffset = flight.onGround ? 0.006 : Math.min(0.075, Math.max(0.014, projectedAltitude / 260000));
  const radius = earthRadius + altitudeOffset;
  const phi = (90 - coords.lat) * (Math.PI / 180);
  const theta = (coords.lon + 180) * (Math.PI / 180);
  return target.set(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function useAircraftFeed(refreshKey: number) {
  const [aircraft, setAircraft] = useState<Aircraft[]>(previewFlights);
  const [state, setState] = useState<FeedState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Pick<FeedResponse, 'mode' | 'sourceTimestamp' | 'refreshAfter'> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const response = await fetch('/api/flights', { cache: 'no-store' });
        const data = (await response.json()) as FeedResponse | { error: string };
        if (!response.ok || !('aircraft' in data)) {
          throw new Error('error' in data ? data.error : 'Live feed unavailable');
        }
        if (cancelled) return;
        setAircraft(data.aircraft);
        setMeta({ mode: data.mode, sourceTimestamp: data.sourceTimestamp, refreshAfter: data.refreshAfter });
        setState('live');
        setError(null);
        timer = setTimeout(load, data.refreshAfter * 1000);
      } catch (loadError) {
        if (cancelled) return;
        setState('preview');
        setError(loadError instanceof Error ? loadError.message : 'Live feed unavailable');
        timer = setTimeout(load, 60_000);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshKey]);

  return { aircraft, state, error, meta };
}

function Earth() {
  const texture = useTexture('/earth-day.jpg');
  texture.colorSpace = SRGBColorSpace;

  return (
    <group>
      <mesh castShadow receiveShadow>
        <sphereGeometry args={[earthRadius, 96, 96]} />
        <meshStandardMaterial map={texture} roughness={0.9} metalness={0.02} />
      </mesh>
      <mesh>
        <sphereGeometry args={[earthRadius + 0.055, 64, 64]} />
        <meshBasicMaterial color="#55dcff" transparent opacity={0.095} side={BackSide} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[earthRadius + 0.13, 64, 64]} />
        <meshBasicMaterial color="#3dbfe8" transparent opacity={0.028} side={BackSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

type AircraftVariant = 'jet' | 'heavy' | 'light' | 'rotor';

function aircraftVariant(category: number): AircraftVariant {
  if (category === 8) return 'rotor';
  if ([2, 9, 12, 14].includes(category)) return 'light';
  if ([5, 6].includes(category)) return 'heavy';
  return 'jet';
}

function modelPart(
  geometry: BufferGeometry,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
) {
  geometry.scale(...scale);
  geometry.rotateX(rotation[0]);
  geometry.rotateY(rotation[1]);
  geometry.rotateZ(rotation[2]);
  geometry.translate(...position);
  if (!geometry.index) return geometry;
  const nonIndexed = geometry.toNonIndexed();
  geometry.dispose();
  return nonIndexed;
}

function createFleetAircraftGeometry(variant: AircraftVariant) {
  const parts: BufferGeometry[] = [];

  if (variant === 'rotor') {
    parts.push(
      modelPart(new CapsuleGeometry(0.012, 0.025, 2, 6), [0, 0, -0.008], [Math.PI / 2, 0, 0], [1.2, 1, 1]),
      modelPart(new BoxGeometry(0.007, 0.007, 0.05), [0, 0, 0.035]),
      modelPart(new BoxGeometry(0.105, 0.0025, 0.006), [0, 0.017, -0.004], [0, 0.22, 0]),
      modelPart(new BoxGeometry(0.006, 0.0025, 0.105), [0, 0.017, -0.004], [0, 0.22, 0]),
      modelPart(new BoxGeometry(0.028, 0.003, 0.004), [0.004, 0.007, 0.06], [0, 0, Math.PI / 2]),
    );
  } else {
    const heavyScale = variant === 'heavy' ? 1.22 : variant === 'light' ? 0.78 : 1;
    const wingSpan = variant === 'heavy' ? 0.112 : variant === 'light' ? 0.075 : 0.094;
    const bodyLength = variant === 'heavy' ? 0.057 : variant === 'light' ? 0.038 : 0.048;
    parts.push(
      modelPart(new CapsuleGeometry(0.009, bodyLength, 2, 7), [0, 0, 0], [Math.PI / 2, 0, 0], [1, 1, heavyScale]),
      modelPart(new ConeGeometry(0.009, 0.019, 7), [0, 0, -(bodyLength / 2 + 0.014)], [Math.PI / 2, 0, 0]),
      modelPart(new BoxGeometry(wingSpan, 0.004, variant === 'light' ? 0.014 : 0.02), [0, 0, -0.004], [0, -0.08, 0]),
      modelPart(new BoxGeometry(wingSpan * 0.4, 0.0035, 0.011), [0, 0.004, bodyLength / 2 + 0.015], [0, 0.05, 0]),
      modelPart(new ConeGeometry(0.012, 0.025, 3), [0, 0.012, bodyLength / 2 + 0.014], [0, 0, 0], [0.55, 1, 1]),
    );
    if (variant !== 'light') {
      parts.push(
        modelPart(new CylinderGeometry(0.0055, 0.0065, 0.018, 6), [-wingSpan * 0.24, -0.003, -0.008], [Math.PI / 2, 0, 0]),
        modelPart(new CylinderGeometry(0.0055, 0.0065, 0.018, 6), [wingSpan * 0.24, -0.003, -0.008], [Math.PI / 2, 0, 0]),
      );
    } else {
      parts.push(modelPart(new BoxGeometry(0.032, 0.0025, 0.004), [0, 0, -(bodyLength / 2 + 0.023)], [0, 0.18, 0]));
    }
  }

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Unable to construct aircraft geometry');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  parts.forEach((part) => part.dispose());
  return merged;
}

function AircraftInstances({
  aircraft,
  variant,
  selectedId,
  predictive,
  onSelect,
}: {
  aircraft: Aircraft[];
  variant: AircraftVariant;
  selectedId?: string;
  predictive: boolean;
  onSelect: (flight: Aircraft) => void;
}) {
  const ref = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const orientation = useMemo(() => new Quaternion(), []);
  const radial = useMemo(() => new Vector3(), []);
  const headingRotation = useMemo(() => new Quaternion(), []);
  const targetPosition = useMemo(() => new Vector3(), []);
  const smoothedPositions = useRef(new Map<string, Vector3>());
  const smoothedOrientations = useRef(new Map<string, Quaternion>());
  const geometry = useMemo(() => createFleetAircraftGeometry(variant), [variant]);

  const updateMatrices = useCallback((timestamp: number, delta: number) => {
    const mesh = ref.current;
    if (!mesh) return;
    const blend = 1 - Math.exp(-Math.min(delta, 0.1) * 7.5);
    aircraft.forEach((flight, index) => {
      globePosition(flight, timestamp, predictive, 0, targetPosition);
      let position = smoothedPositions.current.get(flight.id);
      if (!position) {
        position = targetPosition.clone();
        smoothedPositions.current.set(flight.id, position);
      } else {
        position.lerp(targetPosition, blend);
      }
      radial.copy(targetPosition).normalize();
      orientation.setFromUnitVectors(upVector, radial);
      headingRotation.setFromAxisAngle(radial, -flight.heading * (Math.PI / 180));
      orientation.premultiply(headingRotation);
      let smoothOrientation = smoothedOrientations.current.get(flight.id);
      if (!smoothOrientation) {
        smoothOrientation = orientation.clone();
        smoothedOrientations.current.set(flight.id, smoothOrientation);
      } else {
        smoothOrientation.slerp(orientation, blend);
      }
      dummy.position.copy(position);
      dummy.quaternion.copy(smoothOrientation);
      const scale = flight.id === selectedId ? 1.3 : flight.onGround ? 0.78 : 1;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [aircraft, dummy, headingRotation, orientation, predictive, radial, selectedId, targetPosition]);

  useEffect(() => {
    const visibleIds = new Set(aircraft.map((flight) => flight.id));
    smoothedPositions.current.forEach((_, id) => {
      if (!visibleIds.has(id)) smoothedPositions.current.delete(id);
    });
    smoothedOrientations.current.forEach((_, id) => {
      if (!visibleIds.has(id)) smoothedOrientations.current.delete(id);
    });
  }, [aircraft]);

  useLayoutEffect(() => {
    if (ref.current) ref.current.instanceMatrix.setUsage(DynamicDrawUsage);
    updateMatrices(preciseNowSeconds(), 1);
  }, [updateMatrices]);

  useFrame((_, delta) => {
    updateMatrices(preciseNowSeconds(), delta);
  });

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, aircraft.length]}
      frustumCulled={false}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        if (event.instanceId !== undefined) onSelect(aircraft[event.instanceId]);
      }}
      onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = 'default'; }}
    >
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color={variant === 'heavy' ? '#dff7ff' : variant === 'rotor' ? '#ffd479' : variant === 'light' ? '#8cecff' : '#b9f1ff'}
        emissive={variant === 'rotor' ? '#8a5100' : '#0b7f9a'}
        emissiveIntensity={0.5}
        metalness={0.28}
        roughness={0.38}
      />
    </instancedMesh>
  );
}

function AircraftFleet(props: Omit<Parameters<typeof AircraftInstances>[0], 'aircraft' | 'variant'> & { aircraft: Aircraft[] }) {
  const buckets = useMemo(() => {
    const result: Record<AircraftVariant, Aircraft[]> = { jet: [], heavy: [], light: [], rotor: [] };
    props.aircraft.forEach((flight) => result[aircraftVariant(flight.category)].push(flight));
    return result;
  }, [props.aircraft]);

  return (
    <>
      {(Object.keys(buckets) as AircraftVariant[]).map((variant) => (
        <AircraftInstances key={variant} {...props} variant={variant} aircraft={buckets[variant]} />
      ))}
    </>
  );
}

function DetailedJetModel({ variant }: { variant: AircraftVariant }) {
  const light = variant === 'light';
  const heavy = variant === 'heavy';
  const bodyLength = light ? 0.13 : heavy ? 0.23 : 0.19;
  const wingSpan = light ? 0.18 : heavy ? 0.34 : 0.28;
  const bodyRadius = light ? 0.021 : heavy ? 0.034 : 0.029;
  const windowPositions = light ? [-0.025, 0.012] : [-0.055, -0.025, 0.005, 0.035, 0.065];

  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <capsuleGeometry args={[bodyRadius, bodyLength, 6, 14]} />
        <meshStandardMaterial color="#e8f1f4" metalness={0.45} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0, -(bodyLength / 2 + bodyRadius * 0.78)]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <coneGeometry args={[bodyRadius * 0.93, bodyRadius * 1.75, 14]} />
        <meshStandardMaterial color="#dce9ed" metalness={0.5} roughness={0.24} />
      </mesh>
      <mesh position={[0, bodyRadius * 0.55, -(bodyLength / 2 + bodyRadius * 0.46)]} scale={[0.72, 0.36, 0.72]}>
        <sphereGeometry args={[bodyRadius, 12, 8]} />
        <meshStandardMaterial color="#082434" metalness={0.72} roughness={0.12} />
      </mesh>
      <mesh position={[0, 0, -0.008]} rotation={[0, -0.08, 0]} castShadow>
        <boxGeometry args={[wingSpan, 0.009, light ? 0.055 : 0.075]} />
        <meshStandardMaterial color="#cddde2" metalness={0.52} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.006, bodyLength / 2 + 0.012]} rotation={[0, 0.05, 0]} castShadow>
        <boxGeometry args={[wingSpan * 0.38, 0.008, light ? 0.032 : 0.042]} />
        <meshStandardMaterial color="#dce7ea" metalness={0.48} roughness={0.32} />
      </mesh>
      <mesh position={[0, bodyRadius * 0.95, bodyLength / 2 + 0.012]}>
        <coneGeometry args={[bodyRadius * 0.8, light ? 0.055 : 0.075, 3]} />
        <meshStandardMaterial color="#b9cdd4" metalness={0.42} roughness={0.3} />
      </mesh>
      {!light ? (
        <>
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * wingSpan * 0.26, -0.012, -0.026]} rotation={[Math.PI / 2, 0, 0]} castShadow>
              <cylinderGeometry args={[bodyRadius * 0.32, bodyRadius * 0.38, heavy ? 0.065 : 0.052, 12]} />
              <meshStandardMaterial color="#708791" metalness={0.7} roughness={0.2} />
            </mesh>
          ))}
        </>
      ) : (
        <mesh position={[0, 0, -(bodyLength / 2 + bodyRadius * 1.9)]} rotation={[0.06, 0.18, 0]}>
          <boxGeometry args={[0.105, 0.005, 0.008]} />
          <meshStandardMaterial color="#162b33" metalness={0.55} roughness={0.25} />
        </mesh>
      )}
      {windowPositions.map((z) => (
        <group key={z}>
          <mesh position={[-bodyRadius * 0.96, bodyRadius * 0.28, z]}><boxGeometry args={[0.0025, 0.008, 0.012]} /><meshBasicMaterial color="#183c4a" /></mesh>
          <mesh position={[bodyRadius * 0.96, bodyRadius * 0.28, z]}><boxGeometry args={[0.0025, 0.008, 0.012]} /><meshBasicMaterial color="#183c4a" /></mesh>
        </group>
      ))}
      <mesh position={[-wingSpan / 2, 0, -0.008]}><sphereGeometry args={[0.008, 8, 8]} /><meshBasicMaterial color="#ff3157" toneMapped={false} /></mesh>
      <mesh position={[wingSpan / 2, 0, -0.008]}><sphereGeometry args={[0.008, 8, 8]} /><meshBasicMaterial color="#46ffae" toneMapped={false} /></mesh>
      <mesh position={[0, 0, bodyLength / 2 + 0.05]}><sphereGeometry args={[0.006, 8, 8]} /><meshBasicMaterial color="#ffffff" toneMapped={false} /></mesh>
    </group>
  );
}

function DetailedRotorModel() {
  const mainRotor = useRef<Object3D>(null);
  const tailRotor = useRef<Object3D>(null);
  useFrame((_, delta) => {
    if (mainRotor.current) mainRotor.current.rotation.y += delta * 15;
    if (tailRotor.current) tailRotor.current.rotation.x += delta * 20;
  });

  return (
    <group>
      <mesh position={[0, 0, -0.025]} rotation={[Math.PI / 2, 0, 0]} castShadow><capsuleGeometry args={[0.038, 0.065, 6, 12]} /><meshStandardMaterial color="#dfe8e8" metalness={0.42} roughness={0.3} /></mesh>
      <mesh position={[0, 0.01, -0.073]} scale={[1, 0.72, 1.15]}><sphereGeometry args={[0.037, 12, 10]} /><meshStandardMaterial color="#163d4d" metalness={0.66} roughness={0.15} /></mesh>
      <mesh position={[0, 0.004, 0.08]}><boxGeometry args={[0.018, 0.018, 0.16]} /><meshStandardMaterial color="#9fb5bc" metalness={0.55} roughness={0.28} /></mesh>
      <group ref={mainRotor} position={[0, 0.06, -0.015]}><mesh><boxGeometry args={[0.38, 0.005, 0.014]} /><meshStandardMaterial color="#344850" metalness={0.65} roughness={0.2} /></mesh><mesh><boxGeometry args={[0.014, 0.005, 0.38]} /><meshStandardMaterial color="#344850" metalness={0.65} roughness={0.2} /></mesh></group>
      <group ref={tailRotor} position={[0.012, 0.018, 0.165]} rotation={[0, 0, Math.PI / 2]}><mesh><boxGeometry args={[0.09, 0.004, 0.01]} /><meshBasicMaterial color="#d7f4fb" /></mesh><mesh rotation={[0, 0, Math.PI / 2]}><boxGeometry args={[0.09, 0.004, 0.01]} /><meshBasicMaterial color="#d7f4fb" /></mesh></group>
      <mesh position={[-0.04, -0.045, -0.01]}><boxGeometry args={[0.012, 0.008, 0.15]} /><meshStandardMaterial color="#536870" /></mesh>
      <mesh position={[0.04, -0.045, -0.01]}><boxGeometry args={[0.012, 0.008, 0.15]} /><meshStandardMaterial color="#536870" /></mesh>
      <mesh position={[-0.2, 0.06, -0.015]}><sphereGeometry args={[0.009, 8, 8]} /><meshBasicMaterial color="#ff3157" toneMapped={false} /></mesh>
      <mesh position={[0.2, 0.06, -0.015]}><sphereGeometry args={[0.009, 8, 8]} /><meshBasicMaterial color="#46ffae" toneMapped={false} /></mesh>
    </group>
  );
}

function SelectedAircraft({ flight, predictive, paths }: { flight: Aircraft; predictive: boolean; paths: boolean }) {
  const group = useRef<Object3D>(null);
  const position = useMemo(() => new Vector3(), []);
  const radial = useMemo(() => new Vector3(), []);
  const quaternion = useMemo(() => new Quaternion(), []);
  const headingRotation = useMemo(() => new Quaternion(), []);
  const initialized = useRef(false);
  const trail = useMemo(() => {
    const time = nowSeconds();
    return [-360, -240, -120, 0, 120, 240, 360, 480].map((offset) => globePosition(flight, time, true, offset));
  }, [flight]);

  useFrame((_, delta) => {
    if (!group.current) return;
    globePosition(flight, preciseNowSeconds(), predictive, 0, position);
    radial.copy(position).normalize();
    quaternion.setFromUnitVectors(upVector, radial);
    headingRotation.setFromAxisAngle(radial, -flight.heading * (Math.PI / 180));
    quaternion.premultiply(headingRotation);
    if (!initialized.current) {
      group.current.position.copy(position);
      group.current.quaternion.copy(quaternion);
      initialized.current = true;
      return;
    }
    const blend = 1 - Math.exp(-Math.min(delta, 0.1) * 8);
    group.current.position.lerp(position, blend);
    group.current.quaternion.slerp(quaternion, blend);
  });

  return (
    <>
      {paths && <Line points={trail} color="#dfff65" lineWidth={1} transparent opacity={0.5} />}
      <group ref={group}>
        {aircraftVariant(flight.category) === 'rotor' ? <DetailedRotorModel /> : <DetailedJetModel variant={aircraftVariant(flight.category)} />}
        <mesh position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.2, 0.215, 48]} />
          <meshBasicMaterial color="#efff6d" transparent opacity={0.7} side={2} depthWrite={false} />
        </mesh>
        <pointLight color="#eaff62" intensity={2.4} distance={0.9} />
      </group>
    </>
  );
}

function FlyMovement({ active, speed }: { active: boolean; speed: number }) {
  const { camera } = useThree();
  const keys = useRef(new Set<string>());
  const forward = useMemo(() => new Vector3(), []);
  const right = useMemo(() => new Vector3(), []);
  const localUp = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const down = (event: KeyboardEvent) => keys.current.add(event.code);
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      keys.current.clear();
    };
  }, []);

  useFrame((_, delta) => {
    if (!active) return;
    const held = keys.current;
    const amount = delta * speed * (held.has('ShiftLeft') || held.has('ShiftRight') ? 3.2 : 1);
    camera.getWorldDirection(forward).normalize();
    right.crossVectors(forward, camera.up).normalize();
    localUp.crossVectors(right, forward).normalize();

    if (held.has('KeyZ') || held.has('KeyW') || held.has('ArrowUp')) camera.position.addScaledVector(forward, amount);
    if (held.has('KeyS') || held.has('ArrowDown')) camera.position.addScaledVector(forward, -amount);
    if (held.has('KeyQ') || held.has('KeyA') || held.has('ArrowLeft')) camera.position.addScaledVector(right, -amount);
    if (held.has('KeyD') || held.has('ArrowRight')) camera.position.addScaledVector(right, amount);
    if (held.has('Space') || held.has('KeyR') || held.has('KeyE')) camera.position.addScaledVector(localUp, amount);
    if (held.has('ControlLeft') || held.has('ControlRight') || held.has('KeyF') || held.has('KeyC')) camera.position.addScaledVector(localUp, -amount);
  });

  return null;
}

function CameraDirector({
  selected,
  predictive,
  follow,
  focusRequest,
  resetRequest,
  onPosition,
}: {
  selected: Aircraft | null;
  predictive: boolean;
  follow: boolean;
  focusRequest: number;
  resetRequest: number;
  onPosition: (value: [number, number, number]) => void;
}) {
  const { camera } = useThree();
  const lastFocus = useRef(focusRequest);
  const lastReset = useRef(resetRequest);
  const lastReport = useRef(0);
  const desired = useMemo(() => new Vector3(), []);
  const target = useMemo(() => new Vector3(), []);
  const radial = useMemo(() => new Vector3(), []);

  useFrame(() => {
    if (lastReset.current !== resetRequest) {
      lastReset.current = resetRequest;
      camera.position.set(0, 0.3, 6.7);
      camera.lookAt(0, 0, 0);
    }

    if (selected && lastFocus.current !== focusRequest) {
      lastFocus.current = focusRequest;
      globePosition(selected, preciseNowSeconds(), predictive, 0, target);
      radial.copy(target).normalize();
      camera.position.copy(target).addScaledVector(radial, 0.42);
      camera.lookAt(target);
    }

    if (follow && selected) {
      globePosition(selected, preciseNowSeconds(), predictive, 0, target);
      radial.copy(target).normalize();
      desired.copy(target).addScaledVector(radial, 0.3);
      camera.position.lerp(desired, 0.065);
      camera.lookAt(target);
    }

    const timestamp = performance.now();
    if (timestamp - lastReport.current > 500) {
      lastReport.current = timestamp;
      onPosition([
        Number(camera.position.x.toFixed(2)),
        Number(camera.position.y.toFixed(2)),
        Number(camera.position.z.toFixed(2)),
      ]);
    }
  });

  return null;
}

function GlobeScene({
  aircraft,
  selected,
  predictive,
  paths,
  flyMode,
  follow,
  speed,
  orbitTarget,
  focusRequest,
  resetRequest,
  onFlyMode,
  onPosition,
  onSelect,
}: {
  aircraft: Aircraft[];
  selected: Aircraft | null;
  predictive: boolean;
  paths: boolean;
  flyMode: boolean;
  follow: boolean;
  speed: number;
  orbitTarget: [number, number, number];
  focusRequest: number;
  resetRequest: number;
  onFlyMode: (active: boolean) => void;
  onPosition: (value: [number, number, number]) => void;
  onSelect: (flight: Aircraft) => void;
}) {
  return (
    <>
      <color attach="background" args={['#02070c']} />
      <fog attach="fog" args={['#02070c', 11, 30]} />
      <ambientLight intensity={0.68} />
      <directionalLight position={[5, 2, 4]} intensity={3.15} color={new Color('#d9f4ff')} />
      <pointLight position={[-4, -1, -3]} intensity={2.1} color="#0a4f7c" />
      <Suspense fallback={null}><Earth /></Suspense>
      <AircraftFleet aircraft={aircraft} selectedId={selected?.id} predictive={predictive} onSelect={onSelect} />
      {selected && <SelectedAircraft flight={selected} predictive={predictive} paths={paths} />}
      <Stars radius={70} depth={38} count={2400} factor={2.1} saturation={0.25} fade speed={0.2} />
      <OrbitControls
        makeDefault={!flyMode}
        enabled={!flyMode && !follow}
        enableDamping
        dampingFactor={0.055}
        rotateSpeed={0.48}
        zoomSpeed={0.72}
        panSpeed={0.65}
        minDistance={0.04}
        maxDistance={30}
        enablePan
        target={orbitTarget}
      />
      <PointerLockControls
        selector="#fly-mode-button"
        pointerSpeed={0.55}
        onLock={() => onFlyMode(true)}
        onUnlock={() => onFlyMode(false)}
      />
      <FlyMovement active={flyMode} speed={speed} />
      <CameraDirector selected={selected} predictive={predictive} follow={follow} focusRequest={focusRequest} resetRequest={resetRequest} onPosition={onPosition} />
    </>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string | number; suffix?: string }) {
  return (
    <div className="min-w-0">
      <p className="telemetry-label">{label}</p>
      <p className="mt-1 truncate font-mono text-[13px] font-medium text-white">
        {value}<span className="ml-1 text-[10px] text-slate-500">{suffix}</span>
      </p>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="grid h-5 min-w-5 place-items-center border border-white/15 bg-white/[0.05] px-1 font-mono text-[8px] text-slate-300">{children}</kbd>;
}

export function AirTrafficApp() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { aircraft, state: feedState, error, meta } = useAircraftFeed(refreshKey);
  const [selected, setSelected] = useState<Aircraft | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [flightState, setFlightState] = useState<FlightStateFilter>('airborne');
  const [altitude, setAltitude] = useState([0, 45000]);
  const [speedRange, setSpeedRange] = useState([0, 700]);
  const [country, setCountry] = useState('all');
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [predictive, setPredictive] = useState(true);
  const [paths, setPaths] = useState(true);
  const [flyMode, setFlyMode] = useState(false);
  const [follow, setFollow] = useState(false);
  const [flySpeed, setFlySpeed] = useState([0.65]);
  const [focusRequest, setFocusRequest] = useState(0);
  const [resetRequest, setResetRequest] = useState(0);
  const [cameraPosition, setCameraPosition] = useState<[number, number, number]>([0, 0.3, 6.7]);
  const [orbitTarget, setOrbitTarget] = useState<[number, number, number]>([0, 0, 0]);
  const [utc, setUtc] = useState('00:00:00');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const update = () => setUtc(new Date().toISOString().slice(11, 19));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelected((current) => {
      if (!current) return null;
      return aircraft.find((flight) => flight.id === current.id) ?? current;
    });
  }, [aircraft]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === '/' && document.pointerLockElement === null) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const countries = useMemo(() => [...new Set(aircraft.map((flight) => flight.country))].sort((a, b) => a.localeCompare(b)), [aircraft]);

  const filteredAircraft = useMemo(() => {
    const normalizedQuery = query.trim().toUpperCase();
    let matching = aircraft.filter((flight) => {
      const altitudeFeet = flight.altitude * 3.28084;
      const speedKnots = flight.speed * 1.94384;
      const stateMatch = flightState === 'all' || (flightState === 'ground' ? flight.onGround : !flight.onGround);
      return stateMatch && altitudeFeet >= altitude[0] && altitudeFeet <= altitude[1] && speedKnots >= speedRange[0] && speedKnots <= speedRange[1] && (country === 'all' || flight.country === country);
    });

    if (normalizedQuery) {
      const exact = matching.filter((flight) => flight.callsign.toUpperCase() === normalizedQuery || flight.id.toUpperCase() === normalizedQuery);
      matching = exact.length > 0 ? exact : matching.filter((flight) => flight.callsign.toUpperCase().includes(normalizedQuery) || flight.id.toUpperCase().includes(normalizedQuery) || flight.country.toUpperCase().includes(normalizedQuery));
    }
    return matching;
  }, [aircraft, altitude, country, flightState, query, speedRange]);

  const suggestions = useMemo(() => {
    const normalized = query.trim().toUpperCase();
    if (!normalized) return [];
    return aircraft.filter((flight) => flight.callsign.toUpperCase().includes(normalized) || flight.id.toUpperCase().includes(normalized)).slice(0, 6);
  }, [aircraft, query]);

  const selectFlight = (flight: Aircraft) => {
    setSelected(flight);
    setFollow(false);
    setSearchFocused(false);
  };

  const centerSelected = () => {
    if (!selected) return;
    setFollow(false);
    const target = globePosition(selected, preciseNowSeconds(), predictive);
    setOrbitTarget([target.x, target.y, target.z]);
    setFocusRequest((value) => value + 1);
  };

  const resetCamera = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    setFollow(false);
    setOrbitTarget([0, 0, 0]);
    setResetRequest((value) => value + 1);
  };

  const fullscreen = () => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen();
    else void document.exitFullscreen();
  };

  const lastContactAge = selected ? Math.max(0, nowSeconds() - selected.lastContact) : 0;
  const sourceAge = meta ? Math.max(0, nowSeconds() - meta.sourceTimestamp) : 0;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#02070c] text-slate-100 selection:bg-cyan-300/25">
      <div className="absolute inset-0">
        <Canvas camera={{ position: [0, 0.3, 6.7], fov: 43, near: 0.005, far: 150 }} dpr={[1, 1.65]} gl={{ antialias: true, powerPreference: 'high-performance' }}>
          <GlobeScene
            aircraft={filteredAircraft}
            selected={selected}
            predictive={predictive}
            paths={paths}
            flyMode={flyMode}
            follow={follow}
            speed={flySpeed[0]}
            orbitTarget={orbitTarget}
            focusRequest={focusRequest}
            resetRequest={resetRequest}
            onFlyMode={setFlyMode}
            onPosition={setCameraPosition}
            onSelect={selectFlight}
          />
        </Canvas>
      </div>

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,transparent_0%,transparent_34%,rgba(1,6,11,.34)_75%,rgba(1,5,9,.78)_100%)]" />
      <div className="scanlines pointer-events-none absolute inset-0 opacity-20" />

      <header className="pointer-events-auto absolute inset-x-0 top-0 z-20 flex h-[66px] items-center border-b border-white/[0.08] bg-[#030a10]/72 px-4 backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 place-items-center border border-cyan-300/35 bg-cyan-300/[0.08] text-cyan-200"><Globe2 className="size-[18px]" /></div>
          <div>
            <div className="flex items-center gap-2"><h1 className="font-semibold tracking-[0.16em] text-white">SKYTRACE</h1><span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.18em] ${feedState === 'live' ? 'border-lime-200/20 bg-lime-200/[0.08] text-lime-200' : 'border-amber-200/20 bg-amber-200/[0.08] text-amber-200'}`}>{feedState === 'live' ? 'LIVE' : feedState === 'connecting' ? 'LINKING' : 'PREVIEW'}</span></div>
            <p className="hidden font-mono text-[9px] tracking-[0.14em] text-slate-500 sm:block">GLOBAL AIRSPACE / 3D OPERATIONS</p>
          </div>
        </div>

        <div className="absolute left-1/2 hidden w-[min(38vw,470px)] -translate-x-1/2 md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <Input
            ref={searchRef}
            aria-label="Search by callsign or ICAO24"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => window.setTimeout(() => setSearchFocused(false), 140)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && suggestions[0]) selectFlight(suggestions[0]);
              if (event.key === 'Escape') { setQuery(''); searchRef.current?.blur(); }
            }}
            placeholder="Search flight number or ICAO24…"
            className="h-9 rounded-none border-white/10 bg-white/[0.045] pl-10 pr-24 font-mono text-xs tracking-wide text-white placeholder:text-slate-600 focus-visible:border-cyan-300/50 focus-visible:ring-cyan-300/10"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[9px] tracking-wider text-slate-600">PRESS /</span>
          {searchFocused && query && (
            <div className="absolute top-11 w-full border border-white/10 bg-[#061018]/95 p-1 shadow-2xl backdrop-blur-xl">
              {suggestions.length ? suggestions.map((flight) => (
                <button key={flight.id} onMouseDown={() => selectFlight(flight)} className="flex w-full items-center px-3 py-2.5 text-left hover:bg-cyan-300/[0.08]">
                  <Plane className="mr-3 size-3.5 rotate-45 text-cyan-300" /><span className="font-mono text-[11px] text-white">{flight.callsign}</span><span className="ml-2 font-mono text-[9px] text-slate-600">{flight.id.toUpperCase()}</span><span className="ml-auto truncate pl-3 text-[10px] text-slate-500">{flight.country}</span>
                </button>
              )) : <p className="px-3 py-4 text-center font-mono text-[10px] text-slate-500">NO MATCHING AIRCRAFT</p>}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="mr-2 hidden items-center gap-2 border-r border-white/10 pr-4 lg:flex">
            <span className="relative flex size-2"><span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${feedState === 'live' ? 'bg-lime-300' : 'bg-amber-300'}`} /><span className={`relative inline-flex size-2 rounded-full ${feedState === 'live' ? 'bg-lime-300' : 'bg-amber-300'}`} /></span>
            <span className="font-mono text-[10px] tracking-wider text-slate-400">{formatNumber(filteredAircraft.length)} / {formatNumber(aircraft.length)} TRACKS</span>
          </div>
          <Button onClick={() => setHelpOpen((value) => !value)} variant="ghost" size="icon" className="rounded-none text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Controls help"><CircleHelp /></Button>
          <Button onClick={() => setRefreshKey((value) => value + 1)} variant="ghost" size="icon" className="rounded-none text-slate-400 hover:bg-white/[0.06] hover:text-white" aria-label="Refresh live data"><RefreshCw className={feedState === 'connecting' ? 'animate-spin' : ''} /></Button>
          <Button variant="ghost" size="icon" className="hidden rounded-none text-slate-400 hover:bg-white/[0.06] hover:text-white sm:inline-flex" aria-label="Settings"><Settings2 /></Button>
        </div>
      </header>

      {helpOpen && (
        <div className="pointer-events-auto absolute right-4 top-[78px] z-30 w-[300px] border border-cyan-300/20 bg-[#061018]/95 p-4 shadow-2xl backdrop-blur-xl sm:right-6">
          <div className="flex items-center"><Navigation className="mr-2 size-4 text-cyan-300" /><h2 className="text-[11px] font-semibold tracking-[0.15em]">FREE-FLIGHT CONTROLS</h2><button onClick={() => setHelpOpen(false)} className="ml-auto text-slate-500 hover:text-white"><X className="size-4" /></button></div>
          <p className="mt-3 text-xs leading-5 text-slate-400">Select <span className="text-cyan-200">FLY</span>, then use the mouse to look anywhere. Press Esc to release the mouse.</p>
          <div className="mt-4 grid grid-cols-[1fr_auto] gap-y-3 text-[11px] text-slate-400">
            <span>Forward / back</span><span className="flex gap-1"><Key>Z/W</Key><Key>S</Key><Key>↑↓</Key></span>
            <span>Left / right</span><span className="flex gap-1"><Key>Q/A</Key><Key>D</Key><Key>←→</Key></span>
            <span>Rise / descend</span><span className="flex gap-1"><Key>SPACE</Key><Key>CTRL</Key></span>
            <span>Move faster</span><span className="flex gap-1"><Key>SHIFT</Key></span>
          </div>
          <div className="mt-4 border-t border-white/[0.08] pt-3"><div className="mb-2 flex justify-between"><span className="telemetry-label">Flight speed</span><span className="font-mono text-[9px] text-cyan-200">{flySpeed[0].toFixed(2)} u/s</span></div><Slider min={0.15} max={2.5} step={0.05} value={flySpeed} onValueChange={(value) => setFlySpeed(value as number[])} /></div>
        </div>
      )}

      {feedState === 'preview' && error && (
        <div className="pointer-events-none absolute left-1/2 top-[78px] z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2 font-mono text-[9px] tracking-wider text-amber-100 backdrop-blur-xl"><AlertTriangle className="size-3.5 shrink-0" /><span className="truncate">PREVIEW DATA — {error}</span></div>
      )}

      <aside className={`pointer-events-auto absolute bottom-14 left-3 top-[78px] z-10 flex w-[292px] flex-col border border-white/[0.09] bg-[#061018]/84 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-300 sm:left-6 ${filtersOpen ? 'translate-x-0' : '-translate-x-[calc(100%+32px)]'}`}>
        <div className="flex h-12 shrink-0 items-center border-b border-white/[0.08] px-4"><Filter className="mr-2 size-3.5 text-cyan-300" /><h2 className="text-[11px] font-semibold tracking-[0.15em]">FILTER AIRSPACE</h2><button onClick={() => setFiltersOpen(false)} className="ml-auto text-slate-500 transition hover:text-white" aria-label="Close filters"><X className="size-4" /></button></div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <p className="telemetry-label mb-2.5">Flight state</p>
            <div className="grid grid-cols-3 gap-1.5">{(['airborne', 'ground', 'all'] as FlightStateFilter[]).map((item) => <button key={item} onClick={() => setFlightState(item)} className={`h-8 border font-mono text-[9px] uppercase tracking-wider transition ${flightState === item ? 'border-cyan-300/45 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-white/[0.025] text-slate-500 hover:border-white/20 hover:text-slate-300'}`}>{item}</button>)}</div>
          </section>
          <section>
            <div className="flex items-center justify-between"><p className="telemetry-label">Altitude</p><span className="font-mono text-[9px] text-cyan-200">{formatNumber(altitude[0])} — {formatNumber(altitude[1])} ft</span></div>
            <Slider className="mt-4" min={0} max={60000} step={1000} value={altitude} onValueChange={(value) => setAltitude(value as number[])} />
          </section>
          <section>
            <div className="flex items-center justify-between"><p className="telemetry-label">Ground speed</p><span className="font-mono text-[9px] text-cyan-200">{speedRange[0]} — {speedRange[1]} kt</span></div>
            <Slider className="mt-4" min={0} max={1000} step={10} value={speedRange} onValueChange={(value) => setSpeedRange(value as number[])} />
          </section>
          <section>
            <p className="telemetry-label mb-2.5">Origin country</p>
            <NativeSelect value={country} onChange={(event) => setCountry(event.target.value)} className="w-full" size="default">
              <NativeSelectOption value="all">All countries</NativeSelectOption>
              {countries.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
            </NativeSelect>
          </section>
          <section className="border-t border-white/[0.08] pt-4">
            <p className="telemetry-label mb-3">Visualization</p>
            <label className="flex items-center justify-between py-1.5 text-xs text-slate-300"><span>Predictive movement</span><Switch checked={predictive} onCheckedChange={setPredictive} className="data-checked:bg-cyan-300" /></label>
            <label className="flex items-center justify-between py-1.5 text-xs text-slate-300"><span>Selected flight path</span><Switch checked={paths} onCheckedChange={setPaths} className="data-checked:bg-cyan-300" /></label>
          </section>
          <section className="border-t border-white/[0.08] pt-4">
            <p className="telemetry-label mb-2">Data link</p>
            <div className="space-y-1.5 font-mono text-[9px] tracking-wider text-slate-500"><div className="flex justify-between"><span>SOURCE</span><span className="text-slate-300">OPENSKY NETWORK</span></div><div className="flex justify-between"><span>ACCESS</span><span className={meta?.mode === 'authenticated' ? 'text-lime-200' : 'text-amber-200'}>{meta?.mode?.toUpperCase() ?? 'CONNECTING'}</span></div><div className="flex justify-between"><span>DATA AGE</span><span className="text-slate-300">{meta ? `${sourceAge}s` : '—'}</span></div></div>
            <p className="mt-3 text-[9px] leading-4 text-slate-600">Community receiver coverage varies by region; not every aircraft broadcasts a public position.</p>
          </section>
        </div>
        <div className="border-t border-white/[0.08] p-3"><Button onClick={() => setFiltersOpen(false)} className="h-9 w-full rounded-none bg-cyan-300 font-mono text-[10px] font-semibold tracking-[0.12em] text-[#021016] hover:bg-cyan-200">SHOW AIRCRAFT <span className="ml-auto rounded-sm bg-black/10 px-1.5 py-0.5">{formatNumber(filteredAircraft.length)}</span></Button></div>
      </aside>

      {!filtersOpen && <Button onClick={() => setFiltersOpen(true)} variant="outline" size="icon" className="pointer-events-auto absolute left-3 top-[78px] z-10 rounded-none border-white/10 bg-[#061018]/80 text-cyan-200 backdrop-blur-xl hover:bg-white/10 sm:left-6" aria-label="Open filters"><Filter /></Button>}

      {selected && (
        <aside className="pointer-events-auto absolute bottom-12 left-2 right-2 z-20 flex max-h-[48vh] flex-col border border-white/[0.09] bg-[#061018]/94 shadow-2xl shadow-black/50 backdrop-blur-xl lg:bottom-14 lg:left-auto lg:right-6 lg:top-[78px] lg:max-h-none lg:w-[312px]">
          <div className="border-b border-white/[0.08] p-4">
            <div className="flex items-start gap-3"><div className="grid size-10 place-items-center border border-lime-200/30 bg-lime-200/[0.08] text-lime-200"><Plane className="size-5 rotate-45" /></div><div className="min-w-0"><p className="font-mono text-[9px] tracking-[0.16em] text-lime-200">{selected.onGround ? 'ON GROUND' : 'AIRBORNE'} • TRACKED</p><h2 className="mt-0.5 font-mono text-xl font-semibold tracking-wide text-white">{selected.callsign}</h2></div><button onClick={() => { setSelected(null); setFollow(false); }} className="ml-auto text-slate-500 transition hover:text-white" aria-label="Close aircraft details"><X className="size-4" /></button></div>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-4 border-b border-white/[0.08] p-4 lg:grid-cols-2 lg:gap-y-5">
            <Metric label="ICAO24" value={selected.id.toUpperCase()} /><Metric label="ORIGIN" value={selected.country} /><Metric label="CATEGORY" value={categoryLabels[selected.category] ?? `Category ${selected.category}`} />
            <Metric label="BARO ALTITUDE" value={formatNumber(selected.altitude * 3.28084)} suffix="ft" /><Metric label="GROUND SPEED" value={Math.round(selected.speed * 1.94384)} suffix="kt" /><Metric label="HEADING" value={Math.round(selected.heading)} suffix="°" />
            <Metric label="VERTICAL RATE" value={`${selected.verticalRate >= 0 ? '+' : ''}${Math.round(selected.verticalRate * 196.85)}`} suffix="ft/min" /><Metric label="SQUAWK" value={selected.squawk ?? '—'} /><Metric label="POSITION" value={sourceLabels[selected.positionSource] ?? `SRC ${selected.positionSource}`} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="flex items-center justify-between"><p className="telemetry-label">Position telemetry</p><span className="font-mono text-[9px] text-lime-200">{lastContactAge}s AGO</span></div>
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[9px] tracking-wider text-slate-500"><div className="border border-white/[0.08] bg-[#02080d]/60 p-2"><span>LAT</span><p className="mt-1 text-xs text-slate-200">{selected.lat.toFixed(5)}°</p></div><div className="border border-white/[0.08] bg-[#02080d]/60 p-2"><span>LON</span><p className="mt-1 text-xs text-slate-200">{selected.lon.toFixed(5)}°</p></div></div>
            <p className="mt-3 text-[10px] leading-4 text-slate-500">Live identity and movement data come from the aircraft transponder network. Route, airports, and registration are not included in this free feed.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-white/[0.08] p-3"><Button onClick={centerSelected} variant="outline" className="rounded-none border-white/10 bg-white/[0.025] font-mono text-[9px] tracking-wider text-slate-300 hover:bg-white/10"><Crosshair /> CENTER CLOSE</Button><Button onClick={() => setFollow((value) => !value)} className={`rounded-none font-mono text-[9px] font-semibold tracking-wider ${follow ? 'bg-amber-200 text-[#151003] hover:bg-amber-100' : 'bg-lime-200 text-[#0a1304] hover:bg-lime-100'}`}><LocateFixed /> {follow ? 'STOP FOLLOW' : 'FOLLOW PLANE'}</Button></div>
        </aside>
      )}

      <div className="pointer-events-auto absolute bottom-[58px] left-1/2 z-10 flex -translate-x-1/2 items-center border border-white/[0.09] bg-[#061018]/84 p-1 shadow-xl backdrop-blur-xl">
        <button onClick={resetCamera} className="flex h-8 items-center gap-2 border-r border-white/[0.08] px-3 font-mono text-[9px] tracking-wider text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><Crosshair className="size-3.5" /><span className="hidden sm:inline">RESET</span></button>
        <button id="fly-mode-button" className={`flex h-8 items-center gap-2 border-r border-white/[0.08] px-3 font-mono text-[9px] tracking-wider transition ${flyMode ? 'bg-cyan-300 text-[#021016]' : 'text-cyan-200 hover:bg-cyan-300/10'}`}><Navigation className="size-3.5" /><span>{flyMode ? 'FLYING' : 'FLY'}</span></button>
        <button onClick={() => setHelpOpen(true)} className="flex h-8 items-center gap-2 border-r border-white/[0.08] px-3 font-mono text-[9px] tracking-wider text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><MousePointer2 className="size-3.5" /><span className="hidden sm:inline">CONTROLS</span></button>
        <button onClick={fullscreen} className="flex h-8 items-center gap-2 px-3 font-mono text-[9px] tracking-wider text-slate-400 transition hover:bg-white/[0.06] hover:text-white"><Maximize2 className="size-3.5" /><span className="hidden sm:inline">FULLSCREEN</span></button>
      </div>

      {flyMode && (
        <div className="pointer-events-none absolute left-1/2 top-[84px] z-20 -translate-x-1/2 border border-cyan-300/25 bg-[#041018]/75 px-4 py-2 text-center backdrop-blur-xl"><p className="font-mono text-[9px] tracking-[0.18em] text-cyan-200">FREE FLIGHT ACTIVE</p><p className="mt-1 font-mono text-[8px] tracking-wider text-slate-500">ZQSD / WASD / ARROWS · SPACE/CTRL · MOUSE · ESC TO RELEASE</p></div>
      )}

      <div className="pointer-events-none absolute bottom-[56px] right-3 hidden border border-white/[0.08] bg-[#061018]/72 px-3 py-2 font-mono text-[8px] tracking-wider text-slate-600 backdrop-blur-xl xl:block"><span className="mr-3 text-slate-500">CAMERA XYZ</span>{cameraPosition.map((axis, index) => <span key={index} className="ml-2"><span className="text-cyan-300/60">{['X', 'Y', 'Z'][index]}</span> {axis.toFixed(2)}</span>)}</div>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-10 items-center border-t border-white/[0.08] bg-[#030a10]/82 px-4 font-mono text-[9px] tracking-wider text-slate-600 backdrop-blur-xl sm:px-6">
        <span className="flex items-center gap-2"><Radio className={`size-3 ${feedState === 'live' ? 'text-cyan-300' : 'text-amber-300'}`} /> {feedState === 'live' ? 'OPENSKY LIVE NETWORK' : 'OPENSKY CONNECTION PENDING'}</span><span className="mx-4 hidden h-3 w-px bg-white/10 sm:block" /><span className="hidden sm:inline">UTC {utc}</span><span className="ml-4 hidden text-slate-700 xl:inline">EARTH / NASA BLUE MARBLE</span>
        <div className="ml-auto flex items-center gap-4"><span className="hidden items-center gap-1.5 md:flex"><Activity className="size-3 text-lime-300" /> FLUID LIVE MOTION</span><span className="hidden items-center gap-1.5 xl:flex">{meta ? `${meta.refreshAfter}s SOURCE SYNC` : 'CONNECTING'}</span><span className="hidden items-center gap-1.5 lg:flex"><ArrowUpFromLine className="size-3" /> SPACE</span><span className="hidden items-center gap-1.5 lg:flex"><ArrowDownToLine className="size-3" /> CTRL</span><span className="flex items-center gap-1.5"><Gauge className="size-3" /> 60 FPS</span></div>
      </footer>
    </main>
  );
}
