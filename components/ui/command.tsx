"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn("flex w-full flex-col overflow-hidden bg-surface text-ink", className)} {...props} />;
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-12 items-center gap-3 border-b border-line px-4">
      <Search className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
      <CommandPrimitive.Input
        className={cn("h-full w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3", className)}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn("max-h-40 overflow-y-auto p-2", className)} {...props} />;
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="px-3 py-6 text-center text-sm text-ink-2" {...props} />;
}

function CommandGroup(props: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn("flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-control px-3 text-sm text-ink outline-none data-[selected=true]:bg-hover data-[disabled=true]:opacity-45", className)}
      {...props}
    />
  );
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem };
