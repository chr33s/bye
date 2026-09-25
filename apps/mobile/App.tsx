import React from "react";
import { ByeApp } from "@bye/native-shared/app";
import { mobilePlatform } from "./src/platform.ts";

export default function App() {
  return <ByeApp platform={mobilePlatform} />;
}
