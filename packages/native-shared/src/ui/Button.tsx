import React from "react";
import { Pressable, Text } from "react-native";
import { s } from "./theme.ts";

export const Button = ({
  label,
  onPress,
  primary,
  disabled,
  hint,
  selected,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Set for one option of a choice group: announced as a radio button, drawn as primary when chosen. */
  selected?: boolean;
}) => (
  <Pressable
    accessibilityRole={selected === undefined ? "button" : "radio"}
    accessibilityLabel={label}
    accessibilityHint={hint}
    accessibilityState={{
      disabled: !!disabled,
      ...(selected === undefined ? {} : { checked: selected }),
    }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      s.button,
      (primary || selected) && s.primary,
      { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
    ]}
  >
    <Text style={primary || selected ? s.primaryText : s.text}>{label}</Text>
  </Pressable>
);
