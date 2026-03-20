"use client";

import { useState } from "react";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SectionHeader } from "../ui/section-header";
import { FormField } from "../ui/form-field";
import { LocalDate } from "../ui/local-date";

type ScheduleFrequency = "manual" | "hourly" | "daily" | "weekdays" | "weekly";

interface Schedule {
  id: string;
  agent_id: string;
  name: string | null;
  frequency: ScheduleFrequency;
  time: string | null;
  day_of_week: number | null;
  prompt: string | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  initialSchedules: Schedule[];
  timezone: string;
}

const FREQUENCIES = [
  { value: "manual", label: "Manual (no schedule)" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays (Mon-Fri)" },
  { value: "weekly", label: "Weekly" },
];

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function formatTimeForInput(time: string | null): string {
  if (!time) return "09:00";
  return time.slice(0, 5);
}

export function AgentScheduleForm({ initialSchedules, timezone }: Props) {
  // Note: Schedule CRUD is not currently in the tenant SDK.
  // For a full implementation, a SchedulesResource would need to be added to the SDK.

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Schedules">
        <span className="text-xs text-muted-foreground">Timezone: {timezone}</span>
      </SectionHeader>

      {initialSchedules.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No schedules configured.</p>
      ) : (
        <div className="space-y-4">
          {initialSchedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              timezone={timezone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCard({
  schedule,
  timezone,
}: {
  schedule: Schedule;
  timezone: string;
}) {
  const [frequency, setFrequency] = useState(schedule.frequency);
  const [time, setTime] = useState(formatTimeForInput(schedule.time));
  const [dayOfWeek, setDayOfWeek] = useState(schedule.day_of_week ?? 1);
  const [prompt, setPrompt] = useState(schedule.prompt ?? "");
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [name, setName] = useState(schedule.name ?? "");

  const showTimePicker = ["daily", "weekdays", "weekly"].includes(frequency);
  const showDayPicker = frequency === "weekly";
  const canEnable = frequency !== "manual";

  return (
    <div className="rounded border border-muted-foreground/15 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Schedule name (optional)"
          className="max-w-xs text-sm"
        />
        <div className="flex items-center gap-3">
          {canEnable && (
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  enabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg ring-0 transition-transform ${
                    enabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Frequency">
          <Select
            value={frequency}
            onChange={(e) => {
              const newFreq = e.target.value as ScheduleFrequency;
              setFrequency(newFreq);
              if (newFreq === "manual") setEnabled(false);
              else setEnabled(true);
            }}
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </FormField>

        {showTimePicker && (
          <FormField label={`Time (${timezone})`}>
            <Input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </FormField>
        )}

        {showDayPicker && (
          <FormField label="Day of Week">
            <Select
              value={dayOfWeek.toString()}
              onChange={(e) => setDayOfWeek(parseInt(e.target.value))}
            >
              {DAYS_OF_WEEK.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </Select>
          </FormField>
        )}
      </div>

      {frequency !== "manual" && (
        <FormField label="Prompt">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Enter the prompt to send on each scheduled run..."
            className="resize-y min-h-[60px]"
          />
        </FormField>
      )}

      {(schedule.last_run_at || schedule.next_run_at) && (
        <div className="flex gap-6 text-sm text-muted-foreground pt-1">
          {schedule.last_run_at && (
            <div>
              <span className="font-medium">Last run:</span>{" "}
              <LocalDate value={schedule.last_run_at} />
            </div>
          )}
          {schedule.next_run_at && (
            <div>
              <span className="font-medium">Next run:</span>{" "}
              <LocalDate value={schedule.next_run_at} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
