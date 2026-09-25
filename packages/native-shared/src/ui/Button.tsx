import React from "react";
import { Pressable, Text } from "react-native";
import { s } from "./theme.ts";

export const Button = ({
  label,
  onPress,
  primary,
  disabled,
  hint,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  hint?: string;
}) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityHint={hint}
    accessibilityState={{ disabled: !!disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      s.button,
      primary && s.primary,
      { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
    ]}
  >
    <Text style={primary ? s.primaryText : s.text}>{label}</Text>
  </Pressable>
);
