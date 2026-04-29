export interface CowayDevice {
    deviceId: string;
    name: string;
    model: string;
    modelCode: string;
    productModel: string;
    placeId: string | number;
    serial?: string;
}
export type AirQualityLevel = 1 | 2 | 3 | 4;
export type DeviceMode = 'auto' | 'manual' | 'night' | 'eco' | 'rapid';
export interface DeviceState {
    power: boolean;
    mode: DeviceMode;
    fanSpeed: 1 | 2 | 3 | 4 | 5 | 6;
    lightOn: boolean;
    airQuality: AirQualityLevel;
    pm25?: number;
    pm10?: number;
    preFilterPct: number;
    max2FilterPct: number;
    timerMinutesRemaining?: number;
    mcuVersion?: string;
}
