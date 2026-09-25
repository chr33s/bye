import React from "react";
import { ByeApp } from "@bye/native-shared/app";
import { desktopPlatform } from "./src/platform.ts";

export default function App() {
  return <ByeApp platform={desktopPlatform} />;
}
