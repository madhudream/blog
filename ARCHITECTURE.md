# Blog Architecture - Modular & Composable

This blog is built with **Astro** using a modular, composable architecture that makes it easy to maintain and extend.

## 🎨 Multi-Theme System

The blog supports **5 beautiful themes** that users can switch between:

1. **Lavender Dream** - Soft purples and blues with cream accents (default)
2. **Ocean Breeze** - Cool blues and teals with sandy accents
3. **Forest Sage** - Earthy greens with warm brown tones
4. **Sunset Glow** - Warm oranges and pinks with purple highlights
5. **Midnight Blue** - Deep blues with silver and cyan accents

### Theme Configuration

Themes are defined in `/src/config/themes.ts`. Each theme has:

- **Primary, Secondary, Accent colors** - For gradients and highlights
- **Background gradients** - Multiple layers for depth
- **Text colors** - Primary, secondary, tertiary for hierarchy
- **Card styles** - Background, border, and hover states

### CSS Variables

All components use CSS variables (defined in `:root`) that update dynamically:

```css
--theme-primary-from
--theme-primary-to
--theme-secondary-from
--theme-secondary-to
--theme-accent-from
--theme-accent-to
--theme-bg-base
--theme-bg-gradient1
--theme-bg-gradient2
--theme-bg-gradient3
--theme-text-primary
--theme-text-secondary
--theme-text-tertiary
--theme-card-bg
--theme-card-border
--theme-card-hover
```

## 📦 Components

### Reusable UI Components (`/src/components/`)

#### `ThemePicker.astro`
- Floating button in bottom-right corner
- Shows theme menu with all available themes
- Saves selection to `localStorage`
- Applies theme via CSS variables
- **No props needed** - self-contained

#### `Hero.astro`
- Homepage hero section with animated gradient text
- **Props:**
  - `published` (number) - Apps published count
  - `inProgress` (number) - Apps in progress count
  - `goal` (number) - Target app count

#### `BlogCard.astro`
- Individual blog post card with image, category, and CTA
- **Props:**
  - `title` (string) - Post title
  - `excerpt` (string) - Post description
  - `date` (string) - Publication date
  - `readTime` (string) - Read time estimate
  - `category` (string) - Post category
  - `image` (string) - Post image URL
  - `link` (string) - Post URL
  - `index` (number, optional) - For stagger animation

#### `AppCard.astro`
- Individual app card with icon and description
- **Props:**
  - `title` (string) - App name
  - `description` (string) - App description
  - `icon` (string) - Emoji icon
  - `link` (string) - App URL
  - `category` (string, optional) - App category
  - `status` (string, optional) - App status badge

#### `Sidebar.astro`
- Floating sidebar with navigation, stats, and CTA
- **Props:**
  - `posts` (array) - Blog posts for quick nav
  - `totalApps` (number) - Total apps count
  - `totalPosts` (number) - Total posts count

### Layout (`/src/layouts/`)

#### `Layout.astro`
- Base layout template with:
  - Multi-layer gradient backgrounds (theme-aware)
  - Sticky navigation header
  - Footer with contact info
  - ThemePicker component
- **Props:**
  - `title` (string) - Page title
  - `description` (string, optional) - Meta description

## 🎯 Pages Structure

### Homepage (`/src/pages/index.astro`)
```astro
<Layout>
  <Hero />
  <Section>
    <BlogCard /> (x3)
    <Sidebar />
  </Section>
</Layout>
```

### Apps Page (`/src/pages/apps.astro`)
```astro
<Layout>
  <Header />
  <Grid>
    <AppCard /> (x10)
  </Grid>
</Layout>
```

## 🔧 How to Customize

### Add a New Theme

1. Open `/src/config/themes.ts`
2. Add new theme object to `themes` record:

```typescript
yourtheme: {
  id: 'yourtheme',
  name: 'Your Theme Name',
  description: 'Theme description',
  colors: {
    primary: { from: '#color1', to: '#color2' },
    secondary: { from: '#color3', to: '#color4' },
    // ... etc
  }
}
```

3. Theme automatically appears in ThemePicker!

### Create a New Component

1. Create file in `/src/components/YourComponent.astro`
2. Define props interface:

```typescript
export interface Props {
  title: string;
  // ... more props
}
const { title } = Astro.props;
```

3. Use theme variables:

```astro
<div style="color: var(--theme-text-primary);">
  {title}
</div>
```

### Style with Theme Variables

Always use CSS variables for colors:

```astro
<!-- ✅ Good - adapts to theme -->
<div style="background: var(--theme-card-bg);">

<!-- ❌ Bad - hard-coded color -->
<div class="bg-white">
```

## 🚀 Benefits of This Architecture

1. **Easy Maintenance** - Change component once, updates everywhere
2. **Consistent Design** - Theme variables ensure color consistency
3. **Rapid Iteration** - Add themes without touching components
4. **User Choice** - Let users pick their favorite theme
5. **Type Safety** - TypeScript interfaces for all props
6. **Performance** - CSS variables are native and fast

## 📁 File Structure

```
blog/
├── src/
│   ├── config/
│   │   └── themes.ts           # Theme definitions
│   ├── components/
│   │   ├── ThemePicker.astro   # Theme switcher
│   │   ├── Hero.astro          # Homepage hero
│   │   ├── BlogCard.astro      # Blog post card
│   │   ├── AppCard.astro       # App card
│   │   └── Sidebar.astro       # Sidebar widget
│   ├── layouts/
│   │   └── Layout.astro        # Base layout
│   ├── pages/
│   │   ├── index.astro         # Homepage
│   │   ├── apps.astro          # Apps gallery
│   │   ├── apps/
│   │   │   ├── wordstash.astro
│   │   │   ├── optionmantra.astro
│   │   │   └── contentflow.astro
│   │   └── blog/
│   │       ├── wordstash.astro
│   │       ├── optionmantra.astro
│   │       └── contentflow-cms.astro
│   └── styles/
│       └── global.css          # Global styles + theme variables
├── public/                     # Static assets
│   ├── wordstash/
│   ├── optionmantra/
│   └── contentflow/
└── astro.config.mjs
```

## 🎨 Color Consistency Fixed

All pages now use the same theme system:
- No more hard-coded colors
- No more `bg-white` or specific color classes
- Everything adapts to selected theme
- Light and dark shades derived from theme colors

## 🧪 Testing

```bash
# Development
npm run dev

# Build
npm run build

# Preview build
npm run preview
```

Visit the site and click **"Change Theme"** button in bottom-right to test all themes!

## 📝 Notes

- Themes persist via `localStorage`
- Page refreshes after theme change to fully apply
- All animations and transitions respect theme colors
- Images use smart fallbacks if missing
- Mobile-responsive by default
