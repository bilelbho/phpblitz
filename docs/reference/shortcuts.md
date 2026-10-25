# Keyboard shortcuts

Every command a keymap can bind, with its keys in each of PHPBlitz's keymaps. Pick yours in
*Settings ▸ Keymap* (or on the welcome window's Customize page), and change single shortcuts there.
In the app, *Help ▸ Keyboard Shortcuts* lists them, searchable by name or keys.

These tables are generated from the app's own keymaps, so they always match it. On macOS,
<kbd>Ctrl</kbd> is <kbd>⌘</kbd> and <kbd>Alt</kbd> is <kbd>⌥</kbd>.

<script setup>
import { computed, ref } from 'vue';
import { data } from './shortcuts.data';

const keymap = ref('phpblitz');
const query = ref('');
const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  return data.groups
    .map((g) => ({
      name: g.name,
      rows: g.rows.filter((r) => !q || r.label.toLowerCase().includes(q) || (r.keys[keymap.value] ?? []).some((k) => k.toLowerCase().includes(q))),
    }))
    .filter((g) => g.rows.length);
});
</script>

<div class="keymap-pick">
  <button v-for="k in data.keymaps" :key="k.id" :class="{ on: keymap === k.id }" @click="keymap = k.id">{{ k.label }}</button>
</div>
<input v-model="query" class="keymap-filter" placeholder="Filter by name or keys: rename, Ctrl+Shift…" aria-label="Filter shortcuts">

<template v-for="g in groups" :key="g.name">
  <h2 :id="g.name.toLowerCase().replace(/[^a-z]+/g, '-')">{{ g.name }}</h2>
  <table>
    <thead><tr><th>Command</th><th>Keys</th></tr></thead>
    <tbody>
      <tr v-for="r in g.rows" :key="r.label">
        <td>{{ r.label }}</td>
        <td>
          <template v-if="(r.keys[keymap] ?? []).length">
            <span v-for="(k, i) in r.keys[keymap]" :key="k">{{ i ? ' or ' : '' }}<kbd>{{ k }}</kbd></span>
          </template>
          <span v-else class="none">none</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>
<p v-if="!groups.length">No command matches “{{ query }}”.</p>

<style scoped>
.keymap-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 20px 0 12px;
}
.keymap-pick button {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 14px;
}
.keymap-pick button.on {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #fff;
}
.keymap-filter {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font-size: 14px;
}
.none {
  color: var(--vp-c-text-3);
}
</style>
