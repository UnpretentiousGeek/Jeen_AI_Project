"use client";

import dynamic from "next/dynamic";

const Agentation = dynamic(
  () => import("agentation").then((module) => module.Agentation),
  { ssr: false },
);

export function AgentationToolbar() {
  return <Agentation endpoint="http://127.0.0.1:4747" />;
}
