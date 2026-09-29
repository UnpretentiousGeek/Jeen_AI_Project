"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Option = { value: string; label: string };

export function SearchableSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly Option[];
  placeholder: string;
  searchPlaceholder: string;
  invalid: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="h-9 w-full justify-between px-3 text-left font-normal active:scale-100 aria-invalid:shadow-[0_0_0_1px_var(--red)]"
        >
          <span className={selected ? "truncate" : "truncate text-ink-3"}>{selected?.label ?? placeholder}</span>
          <ChevronDown aria-hidden="true" className="text-ink-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-window border-0 bg-surface p-0 shadow-overlay"
      >
        <Command defaultValue={selected?.label}>
          <CommandInput aria-label={searchPlaceholder} placeholder={searchPlaceholder} />
          <CommandList id={`${id}-options`}>
            <CommandEmpty>No matching options.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  keywords={[option.value]}
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {value === option.value && <Check className="size-4 text-accent-ink" aria-hidden="true" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
