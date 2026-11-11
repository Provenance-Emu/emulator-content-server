<script lang="ts">
  import { readTheme, saveTheme, type ThemeChoice } from '../lib/theme';
  let choice = $state<ThemeChoice>(readTheme());
</script>

<label class="theme-picker">
  Appearance
  <select
    value={choice}
    onchange={(event) => {
      choice = event.currentTarget.value as ThemeChoice;
      saveTheme(choice);
    }}
  >
    <option value="system">Match system</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
</label>
