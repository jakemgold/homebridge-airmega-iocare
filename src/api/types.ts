export interface CowayDevice {
  deviceId: string;       // serial number — Coway calls this `deviceSerial` in payloads
  name: string;           // user-set nickname (`dvcNick`)
  model: string;          // e.g. 'Airmega 400S' (productName)
  modelCode: string;      // e.g. '02EUZ' — internal Coway code; dispatches command shapes
  productModel: string;   // e.g. 'AP-2015E' — the printed model on the unit
  placeId: string | number;
  serial?: string;
}

// Good / Moderate / Unhealthy / Very Unhealthy
export type AirQualityLevel = 1 | 2 | 3 | 4;

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
  preFilterPct: number;   // 0–100
  max2FilterPct: number;  // 0–100
  timerMinutesRemaining?: number;
  // Coway's MCU/firmware version string (e.g. '1.0.6'). Read from the same
  // HTML-scrape `coreData` block as sensors and status; included on every poll
  // so OTA updates flow through to the HomeKit FirmwareRevision characteristic.
  mcuVersion?: string;
}
