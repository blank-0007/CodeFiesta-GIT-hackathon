import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Slider } from "@/components/ui/form-controls";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/menus";
import { cn } from "@/lib/utils";

export function MultiFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: React.ReactNode; count?: number }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const active = value.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("border-dashed", active && "border-solid border-sys/40 bg-sys/5")} aria-label={`Filter by ${label}${active ? `, ${value.length} selected` : ""}`}>
          {label}
          {active && <span className="num rounded bg-sys/15 px-1 text-2xs text-sys">{value.length}</span>}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={value.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(c) => onChange(c ? [...value, o.value] : value.filter((v) => v !== o.value))}
          >
            <span className="flex-1">{o.label}</span>
            {o.count != null && <span className="num text-2xs text-muted-foreground">{o.count}</span>}
          </DropdownMenuCheckboxItem>
        ))}
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={false} onSelect={() => onChange([])} className="justify-center pl-2 text-xs text-muted-foreground">
              Clear
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RangeFilter({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format = (n) => String(n),
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  format?: (n: number) => string;
}) {
  const active = value[0] !== min || value[1] !== max;
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("border-dashed", active && "border-solid border-sys/40 bg-sys/5")}>
          {label}
          {active && <span className="num text-2xs text-sys">{format(value[0])}–{format(value[1])}</span>}
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="mb-3 flex items-center justify-between text-xs">
          <span className="font-medium">{label}</span>
          <span className="num text-muted-foreground">
            {format(local[0])} – {format(local[1])}
          </span>
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={local}
          thumbLabel={label}
          onValueChange={(v) => setLocal([v[0], v[1]])}
          onValueCommit={(v) => onChange([v[0], v[1]])}
        />
        {active && (
          <Button variant="ghost" size="xs" className="mt-3 w-full" onClick={() => onChange([min, max])}>
            Reset
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
  label = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  React.useEffect(() => {
    if (local === value) return;
    const t = setTimeout(() => onChange(local), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} aria-label={label} className="h-8 w-full pl-8 pr-7 text-xs sm:w-56" />
      {local && (
        <button type="button" aria-label="Clear search" onClick={() => { setLocal(""); onChange(""); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
