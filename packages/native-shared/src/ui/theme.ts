import { Platform, StatusBar, StyleSheet } from "react-native";

export const colors = {
  bg: "#f6f1e7",
  surface: "#fdfcf7",
  fg: "#1d1b16",
  muted: "#6a655a",
  accent: "#d5613f",
  accentFg: "#1d1b16",
  pine: "#2f5d50",
  line: "#e2dccd",
  unseen: "#d5613f",
  danger: "#9b2c2c",
};

// Brand faces (design.pdf). Bundle Fraunces ExtraBold Italic and DM Sans in each native project
// under these names; until then the platform falls back to its default face.
export const fonts = {
  display: "Fraunces-ExtraBoldItalic",
  body: "DMSans-Regular",
  bold: "DMSans-Bold",
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // SafeAreaView only insets on iOS; Android 15+ draws edge-to-edge under the status bar.
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0,
  },
  pad: { padding: 16 },
  h1: {
    fontSize: 32,
    fontWeight: "800",
    fontStyle: "italic",
    fontFamily: fonts.display,
    color: colors.fg,
    marginBottom: 12,
  },
  h2: {
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: fonts.bold,
    fontWeight: "700",
    color: colors.muted,
    marginTop: 16,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  text: { fontSize: 16, color: colors.fg, fontFamily: fonts.body },
  muted: { fontSize: 14, color: colors.muted, fontFamily: fonts.body },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowUnseen: { borderLeftWidth: 4, borderLeftColor: colors.unseen },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  avatarText: { fontFamily: fonts.bold, fontWeight: "800", fontSize: 15 },
  sender: { fontSize: 16, fontWeight: "700", color: colors.fg, fontFamily: fonts.bold },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.fg,
    alignItems: "center",
  },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  primaryText: { color: colors.accentFg, fontWeight: "700", fontFamily: fonts.bold },
  input: {
    borderWidth: 1,
    borderColor: colors.fg,
    borderRadius: 16,
    padding: 12,
    fontSize: 16,
    color: colors.fg,
    marginBottom: 10,
  },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: "center" },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
  error: { color: colors.danger, marginVertical: 8 },
});
