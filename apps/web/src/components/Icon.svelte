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
    play: 'M8 5.5v13l10.5-6.5z',
    download: 'M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14',
    upload: 'M12 15.5v-11M7.5 9 12 4.5 16.5 9M5 19.5h14',
    edit: 'M4.5 19.5l1-4L16 5a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L8.5 18.5zM14 7l3 3',
    trash: 'M5 7h14M10 7V4.5h4V7M7 7l.8 12a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1L17 7M10 11v5M14 11v5',
    forward: 'M9.5 6l6 6-6 6',
    refresh: 'M19 12a7 7 0 1 1-2.05-4.95M19 4.5v4h-4',
    camera:
      'M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    display: 'M4 5.5h16v10.5H4zM9 20h6M12 16v4',
    fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  } as const;
  export type IconName = keyof typeof paths;
</script>

<script lang="ts">
  let { name }: { name: IconName } = $props();
</script>

<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
