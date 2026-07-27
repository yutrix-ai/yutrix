import * as React from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSettings } from "@/contexts/SettingsContext";

interface DateTimePickerProps {
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  placeholder?: string;
  className?: string;
}

export function DateTimePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  className,
}: DateTimePickerProps) {
  const { formatDateTime, timeFormat } = useSettings();
  const [isOpen, setIsOpen] = React.useState(false);
  
  // Local state for time
  const [time, setTime] = React.useState({
    hours: value ? value.getHours() : 0,
    minutes: value ? value.getMinutes() : 0,
    seconds: value ? value.getSeconds() : 0,
  });

  React.useEffect(() => {
    if (value) {
      setTime({
        hours: value.getHours(),
        minutes: value.getMinutes(),
        seconds: value.getSeconds(),
      });
    }
  }, [value]);

  const is12h = timeFormat === "12h";

  const handleDateSelect = (selectedDate: Date | undefined) => {
    if (selectedDate) {
      const newDate = new Date(selectedDate);
      newDate.setHours(time.hours, time.minutes, time.seconds);
      onChange?.(newDate);
    } else {
      onChange?.(undefined);
    }
  };

  const handleTimeChange = (field: "hours" | "minutes" | "seconds", val: number) => {
    const newTime = { ...time, [field]: val };
    setTime(newTime);
    if (value) {
      const newDate = new Date(value);
      newDate.setHours(newTime.hours, newTime.minutes, newTime.seconds);
      onChange?.(newDate);
    }
  };

  const pad = (n: number) => String(n).padStart(2, "0");
  const displayHours = is12h ? (time.hours % 12 === 0 ? 12 : time.hours % 12) : time.hours;
  const ampm = time.hours >= 12 ? "PM" : "AM";

  const handleAmPmToggle = () => {
    if (!is12h) return;
    const nextHours = time.hours >= 12 ? time.hours - 12 : time.hours + 12;
    handleTimeChange("hours", nextHours);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={"outline"}
            className={cn(
              "w-full justify-start text-left font-normal bg-background/50 backdrop-blur-sm",
              !value && "text-muted-foreground",
              className
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {value ? formatDateTime(value) : <span>{placeholder}</span>}
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <div className="p-3 bg-card border-b border-border/50">
          <Calendar
            mode="single"
            selected={value}
            onSelect={handleDateSelect}
            className="p-0 border-0"
          />
        </div>
        <div className="flex items-center justify-center p-3 bg-muted/20 gap-1.5 border-t border-border/50">
          <Clock className="h-4 w-4 text-muted-foreground mr-2" />
          <div className="flex items-center gap-1">
            <TimeInput
              value={pad(displayHours)}
              onChange={(v) => handleTimeChange("hours", v)}
              max={is12h ? 12 : 23}
              min={is12h ? 1 : 0}
            />
            <span className="text-muted-foreground font-bold">:</span>
            <TimeInput
              value={pad(time.minutes)}
              onChange={(v) => handleTimeChange("minutes", v)}
              max={59}
              min={0}
            />
            <span className="text-muted-foreground font-bold">:</span>
            <TimeInput
              value={pad(time.seconds)}
              onChange={(v) => handleTimeChange("seconds", v)}
              max={59}
              min={0}
            />
          </div>
          {is12h && (
            <Button
              variant="outline"
              size="sm"
              className="ml-2 h-8 px-2 text-xs font-bold"
              onClick={handleAmPmToggle}
            >
              {ampm}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimeInput({ value, onChange, max, min }: { value: string, onChange: (v: number) => void, max: number, min: number }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => {
        let v = e.target.value.replace(/\D/g, "");
        if (v.length > 2) v = v.slice(-2);
        if (parseInt(v, 10) > max) v = String(max);
        onChange(parseInt(v || "0", 10));
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const step = e.key === "ArrowUp" ? 1 : -1;
          let next = parseInt(value, 10) + step;
          if (next > max) next = min;
          if (next < min) next = max;
          onChange(next);
        }
      }}
      className="w-12 h-8 rounded-md border border-input bg-background px-1 text-center text-sm focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
