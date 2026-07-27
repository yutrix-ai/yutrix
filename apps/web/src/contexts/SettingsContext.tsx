import React, { createContext, useContext, useState, useEffect } from 'react';
import { fetchApi } from '../lib/api';
import { useAuth } from '../lib/store';

export type TokenDisplayUnit = 'raw' | 'K' | 'M';

interface SettingsContextType {
  tokenDisplayUnit: TokenDisplayUnit;
  setTokenDisplayUnit: (unit: TokenDisplayUnit) => void;
  formatToken: (value: number) => string;
  formatCost: (value: number | null | undefined) => string;
  refreshSettings: () => Promise<void>;
  systemName: string;
  systemSlogan: string;
  systemLogoUrl: string;
  sidebarLogoAnimation: string;
  appendSloganToTitle: string;
  hideSystemNameInTitle: string;
  dateFormat: string;
  timeFormat: string;
  formatDateTime: (value: string | Date | number | null | undefined) => string;
  formatDateOnly: (value: string | Date | number | null | undefined) => string;
  formatShortDateTime: (value: string | Date | number | null | undefined) => string;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [tokenDisplayUnit, setTokenDisplayUnitState] = useState<TokenDisplayUnit>('raw');
  const [systemName, setSystemName] = useState('PromptGate');
  const [systemSlogan, setSystemSlogan] = useState('Lightweight LLM Gateway Console');
  const [systemLogoUrl, setSystemLogoUrl] = useState('/favicon.svg');
  const [sidebarLogoAnimation, setSidebarLogoAnimation] = useState('none');
  const [appendSloganToTitle, setAppendSloganToTitle] = useState('false');
  const [hideSystemNameInTitle, setHideSystemNameInTitle] = useState('false');
  const [dateFormat, setDateFormat] = useState('YYYY-MM-DD');
  const [timeFormat, setTimeFormat] = useState('24h');

  const refreshSettings = async () => {
    // We want branding to load even if user is not logged in
    try {
      const data = await fetchApi('/settings/public');
      if (data) {
        if (data.tokenDisplayUnit) {
          setTokenDisplayUnitState(data.tokenDisplayUnit as TokenDisplayUnit);
        }
        if (data.systemName) setSystemName(data.systemName);
        if (data.systemSlogan) setSystemSlogan(data.systemSlogan);
        if (data.systemLogoUrl) setSystemLogoUrl(data.systemLogoUrl);
        if (data.sidebarLogoAnimation) setSidebarLogoAnimation(data.sidebarLogoAnimation);
        if (data.appendSloganToTitle) setAppendSloganToTitle(data.appendSloganToTitle);
        if (data.hideSystemNameInTitle) setHideSystemNameInTitle(data.hideSystemNameInTitle);
        if (data.dateFormat) setDateFormat(data.dateFormat);
        if (data.timeFormat) setTimeFormat(data.timeFormat);
      }
    } catch (e) {
      console.error('Failed to load public settings:', e);
    }
  };

  useEffect(() => {
    refreshSettings();
  }, [user]);

  useEffect(() => {
    if (appendSloganToTitle === 'true' && systemSlogan) {
      if (hideSystemNameInTitle === 'true') {
        document.title = systemSlogan;
      } else {
        document.title = `${systemName || 'PromptGate'} - ${systemSlogan}`;
      }
    } else {
      document.title = systemName || 'PromptGate';
    }
  }, [systemName, systemSlogan, appendSloganToTitle, hideSystemNameInTitle]);

  useEffect(() => {
    let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.getElementsByTagName('head')[0].appendChild(link);
    }
    link.href = systemLogoUrl || '/favicon.svg';
    if (systemLogoUrl?.startsWith('data:image/png;base64')) {
      link.type = 'image/png';
    } else if (systemLogoUrl?.endsWith('.svg')) {
      link.type = 'image/svg+xml';
    } else {
      link.type = 'image/x-icon';
    }
  }, [systemLogoUrl]);

  const setTokenDisplayUnit = (unit: TokenDisplayUnit) => {
    setTokenDisplayUnitState(unit);
  };

  const formatToken = (value: number) => {
    if (value === undefined || value === null) return '0';
    if (tokenDisplayUnit === 'K') {
      return (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
    }
    if (tokenDisplayUnit === 'M') {
      return (value / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'M';
    }
    return value.toLocaleString();
  };

  const formatCost = (value: number | null | undefined) => {
    if (value === undefined || value === null) return '';
    if (value === 0) return '$0.00';
    if (value < 0.01) {
      const str = value.toFixed(6);
      const trimmed = str.replace(/\.?0+$/, '');
      if (trimmed === '0') return '$0.00';
      return '$' + trimmed;
    }
    return '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatDateTime = (value: string | Date | number | null | undefined) => {
    if (!value) return "-";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "-";

    const yyyy = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');

    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');

    let ampm = '';
    if (timeFormat === '12h') {
      ampm = hours >= 12 ? ' PM' : ' AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'
    }
    const HH = timeFormat === '12h' ? String(hours).padStart(2, '0') : String(d.getHours()).padStart(2, '0');

    const timeStr = `${HH}:${minutes}:${seconds}${ampm}`;
    
    let dateStr = '';
    if (dateFormat === 'MM/DD/YYYY') {
      dateStr = `${MM}/${dd}/${yyyy}`;
    } else if (dateFormat === 'DD/MM/YYYY') {
      dateStr = `${dd}/${MM}/${yyyy}`;
    } else {
      dateStr = `${yyyy}-${MM}-${dd}`;
    }

    return `${dateStr} ${timeStr}`;
  };

  const formatDateOnly = (value: string | Date | number | null | undefined) => {
    if (!value) return "-";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "-";

    const yyyy = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');

    if (dateFormat === 'MM/DD/YYYY') {
      return `${MM}/${dd}/${yyyy}`;
    } else if (dateFormat === 'DD/MM/YYYY') {
      return `${dd}/${MM}/${yyyy}`;
    } else {
      return `${yyyy}-${MM}-${dd}`;
    }
  };

  const formatShortDateTime = (value: string | Date | number | null | undefined) => {
    if (!value) return "-";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "-";

    const yyyy = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');

    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');

    let ampm = '';
    if (timeFormat === '12h') {
      ampm = hours >= 12 ? ' PM' : ' AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
    }
    const HH = timeFormat === '12h' ? String(hours).padStart(2, '0') : String(d.getHours()).padStart(2, '0');

    const timeStr = `${HH}:${minutes}${ampm}`;
    
    let dateStr = '';
    if (dateFormat === 'MM/DD/YYYY') {
      dateStr = `${MM}/${dd}/${yyyy}`;
    } else if (dateFormat === 'DD/MM/YYYY') {
      dateStr = `${dd}/${MM}/${yyyy}`;
    } else {
      dateStr = `${yyyy}-${MM}-${dd}`;
    }

    return `${dateStr} ${timeStr}`;
  };

  return (
    <SettingsContext.Provider value={{ 
      tokenDisplayUnit, setTokenDisplayUnit, formatToken, formatCost, refreshSettings, 
      systemName, systemSlogan, systemLogoUrl, sidebarLogoAnimation, appendSloganToTitle, hideSystemNameInTitle,
      dateFormat, timeFormat, formatDateTime, formatDateOnly, formatShortDateTime
    }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
