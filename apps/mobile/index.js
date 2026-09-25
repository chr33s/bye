// Polyfills first: WHATWG URL/URLSearchParams and crypto.getRandomValues are not complete in Hermes.
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import { AppRegistry } from "react-native";
import App from "./App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
