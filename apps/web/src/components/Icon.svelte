<script lang="ts" module>
  // Light single-stroke glyphs drawn on a 24px grid. Decorative: the control's text is its name.
  const paths = {
    home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
    library: 'M5 4h3.5v16H5zM11 4h3.5v16H11zM17 7.2l3-.8 2 12.8-3 .8z',
    folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
    plus: 'M12 5v14M5 12h14',
    settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
    guide: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
    'sign-out': 'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h9',
    'sign-in': 'M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M14 8l4 4-4 4M18 12H9',
    back: 'M14.5 6l-6 6 6 6',
    menu: 'M4 7h16M4 12h16M4 17h16',
    close: 'M6 6l12 12M18 6 6 18',
    arrow: 'M7 17 17 7M9 7h8v8',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    minus: 'M6 12h12',
    server: 'M5 4.5h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM5 13.5h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM7.5 7.5h.01M7.5 16.5h.01',
    games: 'M7 8h10a4 4 0 0 1 4 4v1.5a2.5 2.5 0 0 1-4.6 1.4L15.5 14h-7l-.9.9A2.5 2.5 0 0 1 3 13.5V12a4 4 0 0 1 4-4zM8 10v3M6.5 11.5h3M16 11.5h.01',
  } as const;
  export type IconName = keyof typeof paths;
</script>

<script lang="ts">
  let { name }: { name: IconName } = $props();
</script>

<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
