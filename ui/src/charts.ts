// Separate entry point for Recharts-based components.
// Import from "@getcatalystiq/agent-plane-ui/charts" to keep Recharts ~50KB out of core bundle.
export { RunCharts } from "./components/pages/run-charts";
export type { DailyAgentStat } from "./components/pages/run-charts";
