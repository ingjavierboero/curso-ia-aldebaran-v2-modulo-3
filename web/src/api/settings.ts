import { api } from './client';

export interface SettingsInput {
  mailboxIntervalMinutes: number;
  billingTime: string;
  reminderTime: string;
  retryCount: number;
  retryWaitMinutes: number;
  pointOfSale: number;
  issuerBusinessName: string | null;
  /** RF-215: firmante y remitente de los emails; no va en el PDF. */
  issuerTradeName: string | null;
  issuerAddress: string | null;
  issuerIvaCondition: string | null;
  issuerGrossIncomeNumber: string | null;
  /** YYYY-MM-DD */
  issuerActivityStartDate: string | null;
}

export interface Settings extends SettingsInput {
  /** CUIT del emisor; sale de ARCA_CUIT y no se edita desde la web. */
  issuerCuit: string;
  mockMode: boolean;
  updatedAt: string;
}

export async function getSettings(): Promise<Settings> {
  return (await api<{ settings: Settings }>('GET', '/settings')).settings;
}

export async function saveSettings(input: SettingsInput): Promise<Settings> {
  return (await api<{ settings: Settings }>('PUT', '/settings', input)).settings;
}
