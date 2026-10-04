export interface CowayDevice {
  deviceId: string;       // serial number — Coway calls this `deviceSerial` in payloads
  name: string;           // user-set nickname (`dvcNick`)
  model: string;          // also `dvcNick`; HomeKit Model fallback when productModel is missing
  modelCode: string;      // e.g. '02EUZ' — internal Coway code; dispatches command shapes
  productModel: string;   // e.g. 'AP-2015E' — the printed model on the unit
  placeId: string | number;
  serial?: string;
}

// HomeKit AirQuality characteristic values:
//   0 = Unknown, 1 = Excellent, 2 = Good, 3 = Fair, 4 = Inferior, 5 = Poor.
// Coway emits four grades (1=Good, 2=Moderate, 3=Unhealthy, 4=Very Unhealthy
// per the IoCare+ labels); we map them 1/3/4/5 so both endpoints stay
// reachable — the cleanest grade reads Excellent, the worst reads Poor — and
// skip HomeKit's "Good" (2). An interior hole is harmless for the Home app's
// rises-above/falls-below automation triggers, unlike an unreachable
// endpoint. 0 (Unknown) covers a missing grade so we don't lie about state
// by defaulting to Excellent.
export type AirQualityLevel = 0 | 1 | 3 | 4 | 5;

// Coway's actual mode register values; the accessory layer maps these to the
// HomeKit-side concepts (Sleep/Eco/Smart preset switches + Auto/Manual target).
export type DeviceMode = 'auto' | 'manual' | 'night' | 'eco' | 'rapid';

export interface DeviceState {
  power: boolean;
  mode: DeviceMode;
  fanSpeed: 1 | 2 | 3 | 4 | 5 | 6;
  lightOn: boolean;
  airQuality: AirQualityLevel;
  pm25?: number;
  pm10?: number;
  // Filter percentages are undefined when Coway hasn't returned a value for
  // them yet (the 250S /supplies endpoint is still under development, per
  // cowayaio). The accessory layer treats undefined as "unknown" — it skips
  // pushing the characteristic so HomeKit keeps its last known value rather
  // than reading a synthesized 100%.
  preFilterPct?: number;   // 0–100
  max2FilterPct?: number;  // 0–100
  timerMinutesRemaining?: number;
  // Coway's MCU/firmware version string (e.g. '1.0.6'), from the status page's
  // `coreData` block when present, so OTA updates flow through to the HomeKit
  // FirmwareRevision characteristic. Coway's current page omits it.
  mcuVersion?: string;
}
