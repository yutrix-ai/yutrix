import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface TimePicker24hProps {
  value: string; // "HH:MM"
  onChange: (value: string) => void;
  className?: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

export function TimePicker24h({ value, onChange, className }: TimePicker24hProps) {
  const [hour, minute] = (value || "00:00").split(":");
  const currentHour = HOURS.includes(hour) ? hour : "00";
  const currentMinute = MINUTES.includes(minute) ? minute : "00";

  const handleHourChange = (newHour: string) => {
    onChange(`${newHour}:${currentMinute}`);
  };

  const handleMinuteChange = (newMinute: string) => {
    onChange(`${currentHour}:${newMinute}`);
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Select value={currentHour} onValueChange={handleHourChange}>
        <SelectTrigger className="w-20 h-9 text-sm font-normal">
          <SelectValue placeholder="小时" />
        </SelectTrigger>
        <SelectContent className="max-h-60">
          {HOURS.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-muted-foreground font-medium select-none">:</span>

      <Select value={currentMinute} onValueChange={handleMinuteChange}>
        <SelectTrigger className="w-20 h-9 text-sm font-normal">
          <SelectValue placeholder="分钟" />
        </SelectTrigger>
        <SelectContent className="max-h-60">
          {MINUTES.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export default TimePicker24h;
