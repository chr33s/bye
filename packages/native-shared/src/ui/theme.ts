import { StyleSheet } from "react-native";

export const colors = {
  bg: "#fbfaf7",
  fg: "#1d1d1b",
  muted: "#6b6860",
  accent: "#1f3a5f",
  line: "#e4e1d8",
  unseen: "#fff6d6",
  danger: "#9b2c2c",
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 16 },
  h1: { fontSize: 24, fontWeight: "700", color: colors.fg, marginBottom: 12 },
  h2: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.muted,
    marginTop: 16,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  text: { fontSize: 16, color: colors.fg },
  muted: { fontSize: 14, color: colors.muted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowUnseen: { backgroundColor: colors.unseen },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
  },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  primaryText: { color: colors.bg, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 10,
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
