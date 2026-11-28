import { decStr, t as tr } from '../i18n'
import { CheckinNudge } from '../components/Checkin'
import { overrideKcal, sendCorrection, withOverride } from '../foodCorrections'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Num, useTween } from '../anim'
import { requireAi } from '../components/AiCredit'
import { FoodPhoto, type KnownFood, type PhotoItem } from '../components/FoodPhoto'
import { MealSuggest } from '../components/MealSuggest'
import { Scanner } from '../components/Scanner'
import { HWheel, Icon, Sheet, Tap } from '../components/ui'
import { BASICS } from '../data/foods'
import { foodAi, shrink } from '../foodAi'
import { dateLabel, fmtInt, haptic, localIso, today, uid } from '../lib'
import {
  dayTotals, fmtG, forGrams, kcalTarget, macroTargets, offFillValues, offProduct, offSearch, recipeAsFood, recipeTotal, recipeWeight,
  type Macros, type OffHit,
} from '../nutrition'
import { useStore } from '../store'
import { MEALS, type Food, type FoodEntry, type Meal, type Phase, type Recipe } from '../types'
import { RecipeEditor } from './RecipeEditor'

const addDays = (iso: string, d: number) => {
  const t = new Date(iso + 'T12:00:00')
  t.setDate(t.getDate() + d)
  return t.toISOString().slice(0, 10)
}

const mealAt = (): Meal => {
  const h = new Date().getHours()
  return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snack'
}

/** Neutral chrome up to 60 % of a goal, then fading into mint until it is reached. */
const mix = (a: string, b: string, t: number) => {
  const pa = a.match(/\w\w/g)!.map((x) => parseInt(x, 16))
  const pb = b.match(/\w\w/g)!.map((x) => parseInt(x, 16))
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
const greenness = (frac: number) => Math.max(0, Math.min(1, (frac - 0.6) / 0.4))
export const progressColors = (frac: number) => {
  const t = greenness(frac)
  return { from: mix('#8e8e93', '#5fae73', t), to: mix('#f2f2f7', '#a6e0b2', t) }
}

/** What can be picked: a food (per 100 g) or a recipe. */
export type Pick = { kind: 'food'; food: Food } | { kind: 'recipe'; recipe: Recipe }
const pickFood = (p: Pick): Food => (p.kind === 'food' ? p.food : recipeAsFood(p.recipe))
const pickName = (p: Pick) => (p.kind === 'food' ? p.food.name : p.recipe.name)

export function Nutrition() {
  const store = useStore()
  const { foodLog, phases, weights } = store
  const [date, setDate] = useState(today())
  // day arrows appear after tapping the title; tapping again (on another day) jumps back to today
  const [dayNav, setDayNav] = useState(false)
  // counts added entries; each one plays the check animation once
  const [added, setAdded] = useState(0)
  const [adding, setAdding] = useState<null | 'search' | 'scan'>(null)
  const [editing, setEditing] = useState<FoodEntry | null>(null)
  const [photo, setPhoto] = useState<File | null>(null)
  const [suggest, setSuggest] = useState(false)
  // with meal sections on, "+" on a section adds into that meal
  const [addMeal, setAddMeal] = useState<Meal | null>(null)
  const mealOf = () => addMeal ?? mealAt()
  const photoInput = useRef<HTMLInputElement>(null)

  // newest first
  const day = useMemo(() => foodLog.filter((e) => e.date === date).reverse(), [foodLog, date])
  const total = useMemo(() => dayTotals(foodLog, date), [foodLog, date])
  const target = macroTargets(kcalTarget(phases, date), weights)

  const saveItems = (items: PhotoItem[]) => {
    const at = localIso()
    for (const it of items) {
      store.saveFoodEntry({
        id: uid(), date, meal: mealOf(), name: it.food.name, grams: it.grams, ...forGrams(it.food, it.grams), at,
        ref: it.recipeId ? { kind: 'recipe', id: it.recipeId } : { kind: 'food', food: it.food },
      })
    }
    setAdded((n) => n + 1)
  }


  return (
    <div className="screen">
      <div className="nut-top">
        <div className="eyebrow" style={{ margin: 0 }}>{tr('Ernährung', 'Nutrition')}</div>
        <EatStreak />
      </div>
      <div className="nut-day">
        <button className="icon-btn" style={dayNav ? undefined : { visibility: 'hidden' }} onClick={() => setDate(addDays(date, -1))} aria-label={tr('Vorheriger Tag', 'Previous day')}><Icon.back /></button>
        <button className="nut-day-title" onClick={() => { if (dayNav && date !== today()) setDate(today()); else setDayNav(!dayNav) }}>
          <h1 className="title" style={{ margin: 0 }}>{date === today() ? tr('Heute', 'Today') : date === addDays(today(), -1) ? tr('Gestern', 'Yesterday') : dateLabel(date, false)}</h1>
        </button>
        <button className="icon-btn" style={{ transform: 'scaleX(-1)', visibility: dayNav && date < today() ? undefined : 'hidden' }} onClick={() => setDate(addDays(date, 1))} aria-label={tr('Nächster Tag', 'Next day')}><Icon.back /></button>
      </div>

      <CheckinNudge />
      <div className="card chrome-edge nut-ring-card">
        <KcalRing eaten={total.kcal} target={target.kcal} flash={added} onClick={() => { haptic(); setSuggest(true) }} />
        <div className="nut-macros">
          <MacroBar label={tr('Eiweiß', 'Protein')} v={total.p} t={target.p} />
          <MacroBar label={tr('Kohlenhydrate', 'Carbs')} v={total.c} t={target.c} />
          <MacroBar label={tr('Fett', 'Fat')} v={total.f} t={target.f} />
        </div>
      </div>
      {target.kcal == null && <div className="hint"><span>{tr('Kein Kalorienziel – leg unter Körper eine Phase mit Kalorien an.', 'No calorie target – create a phase with calories under Body.')}</span></div>}
      {target.kcal != null && date === today() && new Date().getHours() >= 18 && total.kcal > 0 && total.p < target.p * 0.75 && (
        <div className="hint"><span>{tr('Noch ', 'Still ')}<b>{Math.round(target.p - total.p)} g {tr('Eiweiß', 'protein')}</b>{tr(' bis zu deinem Ziel – z. B. Skyr, Topfen oder ein Shake.', ' to your goal – e.g. skyr, quark or a shake.')}</span></div>
      )}

      <div className="nut-actions">
        <Tap className="btn btn-chrome" onClick={() => { haptic(); setAdding('search') }}><Icon.plus /> {tr('Hinzufügen', 'Add')}</Tap>
        <Tap className="nut-scan big" onClick={() => { haptic(); if (requireAi()) photoInput.current?.click() }} aria-label={tr('Essen fotografieren', 'Photograph food')}><CameraIcon /></Tap>
        <Tap className="nut-scan big" onClick={() => { haptic(); setAdding('scan') }} aria-label={tr('Barcode scannen', 'Scan barcode')}><ScanIcon /></Tap>
        <input ref={photoInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhoto(f); e.target.value = '' }} />
      </div>

      {/* the day's entries in one box that scrolls on its own, so the page stays short */}
      {store.settings.mealSections ? (
        <div className="card nut-day-box">
        {MEALS.map((m) => {
          const items = day.filter((e) => e.meal === m.id)
          const kcal = items.reduce((n, e) => n + e.kcal, 0)
          return (
            <div key={m.id} className="nut-meal">
              <div className="nut-meal-head">
                <b>{m.label}</b>
                <span className="faint num">{items.length ? `${fmtInt(kcal)} kcal` : ''}</span>
                <button className="nut-meal-add" onClick={() => { haptic(); setAddMeal(m.id); setAdding('search') }} aria-label={tr(`${m.label} hinzufügen`, `Add to ${m.label}`)}><Icon.plus /></button>
              </div>
              {items.map((e) => <EntryRow key={e.id} e={e} onOpen={() => setEditing(e)} />)}
            </div>
          )
        })}
        </div>
      ) : day.length > 0 && (
        <div className="card nut-day-box">
          {day.map((e) => <EntryRow key={e.id} e={e} onOpen={() => setEditing(e)} />)}
        </div>
      )}

      {adding && (
        <FoodPicker
          title={tr('Hinzufügen', 'Add')}
          startScan={adding === 'scan'}
          onClose={() => { setAdding(null); setAddMeal(null) }}
          onPickMany={(items) => { saveItems(items); setAdding(null); setAddMeal(null) }}
          onPick={(p, grams, portion) => {
            const m = forGrams(pickFood(p), grams)
            store.saveFoodEntry({
              id: uid(), date, meal: mealOf(), name: pickName(p), grams, ...m, at: localIso(), ...(portion ? { portion } : {}),
              ref: p.kind === 'food' ? { kind: 'food', food: p.food } : { kind: 'recipe', id: p.recipe.id },
            })
            if (p.kind === 'food' && p.food.source === 'off') store.saveFood(p.food) // keep for offline + recents
            haptic()
            setAdding(null)
            setAddMeal(null)
            setAdded((n) => n + 1)
          }}
        />
      )}
      {photo && (
        <FoodPhoto
          source={{ kind: 'photo', file: photo }}
          onClose={() => setPhoto(null)}
          onAdd={(items) => { saveItems(items); setPhoto(null) }}
        />
      )}
      {suggest && (
        <MealSuggest
          left={{
            kcal: target.kcal == null ? null : target.kcal - total.kcal,
            p: target.p - total.p,
            c: target.c == null ? null : target.c - total.c,
            f: target.f == null ? null : target.f - total.f,
          }}
          onClose={() => setSuggest(false)}
          onAdd={(items) => { saveItems(items); setSuggest(false) }}
        />
      )}
      {editing && <EntrySheet entry={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function KcalRing({ eaten, target, flash = 0, onClick }: { eaten: number; target: number | null; flash?: number; onClick?: () => void }) {
  // after adding: the check plays in the middle of the ring, then the numbers come back
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    if (!flash) return
    setChecking(true)
    const t = setTimeout(() => setChecking(false), 1100)
    return () => clearTimeout(t)
  }, [flash])
  const r = 52
  const c = 2 * Math.PI * r
  const raw = target ? eaten / target : 0
  const frac = useTween(Math.min(1, raw), { from: 0, ms: 900, intro: 'kcal-ring' })
  const col = progressColors(raw)
  const left = target != null ? Math.round(target - eaten) : null
  return (
    <button className="nut-ring" onClick={onClick} aria-label={tr('Was soll ich noch essen?', 'What should I still eat?')}>
      <svg viewBox="0 0 120 120" width="132" height="132">
        <defs>
          <linearGradient id="nutRing" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor={col.to} /><stop offset=".55" stopColor={col.from} /><stop offset="1" stopColor={col.to} /></linearGradient>
        </defs>
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="9" />
        <circle cx="60" cy="60" r={r} fill="none" stroke="url(#nutRing)" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 60 60)" />
      </svg>
      {checking ? (
        <div className="nut-ring-txt" key={flash}>
          <svg className="ring-check" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
            <path className="scan-check-p" d="M20 33.5 28.5 42 45 24" />
          </svg>
        </div>
      ) : (
      <div className="nut-ring-txt ring-back">
        <b className="num"><Num value={eaten} format={fmtInt} /></b>
        <span className="faint">{target ? tr(`von ${fmtInt(target)}`, `of ${fmtInt(target)}`) : 'kcal'}</span>
        {left != null && <span className="nut-left num" style={raw >= 1 ? { color: 'var(--good)' } : undefined}>{left >= 0 ? tr(`${fmtInt(left)} übrig`, `${fmtInt(left)} left`) : tr(`${fmtInt(-left)} drüber`, `${fmtInt(-left)} over`)}</span>}
      </div>
      )}
    </button>
  )
}

function MacroBar({ label, v, t }: { label: string; v: number; t: number | null }) {
  const w = useTween(t ? Math.min(100, (v / t) * 100) : 0, { from: 0, ms: 800, intro: `macro-${label}` })
  return (
    <div className="nut-macro">
      <div className="nut-macro-top"><span>{label}</span><span className="num faint" style={t && v >= t ? { color: 'var(--good)' } : undefined}><Num value={v} />{t ? ` / ${t}` : ''} g</span></div>
      <div className="track"><div className="fill" style={{ width: `${w}%`, background: t ? `linear-gradient(90deg, ${progressColors(v / t).from}, ${progressColors(v / t).to})` : undefined }} /></div>
    </div>
  )
}

// ---------------------------------------------------------------- picking food

/** Full-screen search: recents, recipes, own foods, basics and Open Food Facts; plus barcode scan. */
export function FoodPicker({ title, onPick, onPickMany, onClose, noRecipes, startScan }: {
  title: string
  onPick: (p: Pick, grams: number, portion?: { g: number; n: number }) => void
  /** several foods at once (AI text entry); the AI row only shows when set */
  onPickMany?: (items: PhotoItem[]) => void
  onClose: () => void
  noRecipes?: boolean
  /** open straight into the camera (scan button) */
  startScan?: boolean
}) {
  const { foodLog, foods, recipes, saveFood, settings, saveSettings } = useStore()
  const notes = useMemo(() => settings.foodNotes ?? {}, [settings.foodNotes])
  const [q, setQ] = useState('')
  const [remote, setRemote] = useState<OffHit[]>([])
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)
  const [scan, setScan] = useState(!!startScan)
  const [view, setView] = useState<'recent' | 'recipes' | 'favs'>('recent')
  const [editRecipe, setEditRecipe] = useState<Recipe | null | 'new'>(null)
  const [missing, setMissing] = useState<{ code: string; name?: string } | null>(null)
  const [chosen, setChosen] = useState<Pick | null>(null)
  const [custom, setCustom] = useState<{ barcode?: string; name?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [aiText, setAiText] = useState<string | null>(null)
  const [editing, setEditing] = useState<Food | null>(null)
  const updateFood = useUpdateFood()
  const ctrl = useRef<AbortController | null>(null)


  // recently logged, newest first, unique
  const recents = useMemo(() => {
    const out: Pick[] = []
    const seen = new Set<string>()
    for (let i = foodLog.length - 1; i >= 0 && out.length < 20; i--) {
      const r = foodLog[i].ref
      const key = r.kind === 'food' ? r.food.id : r.id
      if (seen.has(key)) continue
      seen.add(key)
      if (r.kind === 'food') out.push({ kind: 'food', food: r.food })
      else {
        const rec = recipes.find((x) => x.id === r.id)
        if (rec && !noRecipes) out.push({ kind: 'recipe', recipe: rec })
      }
    }
    return out
  }, [foodLog, recipes, noRecipes])

  // what the AI text entry may map to: recipes, own and recently eaten foods, basics
  const known = useMemo(() => {
    if (!aiText) return []
    const out: KnownFood[] = []
    const seen = new Set<string>()
    const push = (k: KnownFood) => { if (!seen.has(k.id)) { seen.add(k.id); out.push(notes[k.id] ? { ...k, note: notes[k.id] } : k) } }
    if (!noRecipes) for (const r of recipes) push({ id: r.id, food: recipeAsFood(r), recipeId: r.id, g: recipeWeight(r) })
    for (const f of foods) push({ id: f.id, food: f })
    for (const p of recents) if (p.kind === 'food') push({ id: p.food.id, food: p.food })
    for (const f of BASICS) push({ id: f.id, food: f })
    return out
  }, [aiText, recipes, foods, recents, noRecipes, notes])

  // favourites: heart in every row, own list behind the heart button in the header
  const favIds = useMemo(() => new Set(settings.favFoods ?? []), [settings.favFoods])
  const pickId = (p: Pick) => (p.kind === 'food' ? p.food.id : p.recipe.id)
  // the amount from the last time this food / recipe was logged is suggested again
  const lastAmount = (p: Pick): { initial?: number; initialCount?: number } => {
    const id = pickId(p)
    for (let i = foodLog.length - 1; i >= 0; i--) {
      const e = foodLog[i]
      if ((e.ref.kind === 'food' ? e.ref.food.id : e.ref.id) !== id) continue
      return e.portion ? { initial: e.portion.g, initialCount: e.portion.n } : { initial: e.grams }
    }
    return {}
  }
  const toggleFav = (p: Pick) => {
    haptic()
    const id = pickId(p)
    const has = favIds.has(id)
    // products from the online search are kept locally so the favourite works offline
    if (!has && p.kind === 'food' && p.food.source === 'off') saveFood(p.food)
    saveSettings({ ...settings, favFoods: has ? [...favIds].filter((x) => x !== id) : [...favIds, id] })
  }
  const favs = useMemo(() => {
    const out: Pick[] = []
    for (const id of settings.favFoods ?? []) {
      const r = recipes.find((x) => x.id === id)
      if (r) { if (!noRecipes) out.push({ kind: 'recipe', recipe: r }); continue }
      const f = foods.find((x) => x.id === id) ?? BASICS.find((x) => x.id === id)
        ?? foodLog.find((e) => e.ref.kind === 'food' && e.ref.food.id === id)?.ref as { kind: 'food'; food: Food } | undefined
      if (f) out.push({ kind: 'food', food: 'food' in f ? f.food : f })
    }
    return out
  }, [settings.favFoods, recipes, foods, foodLog, noRecipes])

  const term = q.trim().toLowerCase()
  const local = useMemo(() => {
    if (!term) return []
    const words = term.split(/\s+/)
    const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w))
    const note = (id: string) => ' ' + (notes[id] ?? '')
    const out: Pick[] = []
    if (!noRecipes) for (const r of recipes) if (hit(r.name + note(r.id))) out.push({ kind: 'recipe', recipe: r })
    for (const f of foods) if (hit(f.name + ' ' + (f.brand ?? '') + note(f.id))) out.push({ kind: 'food', food: withOverride(f) })
    for (const f of BASICS) if (hit(f.name + note(f.id))) out.push({ kind: 'food', food: f })
    // eaten foods that are only in the diary (e.g. from the AI) can be found by their note too
    for (const id of Object.keys(notes)) {
      if (out.some((p) => pickId(p) === id) || !hit(note(id))) continue
      const e = foodLog.find((x) => x.ref.kind === 'food' && x.ref.food.id === id)
      if (e && e.ref.kind === 'food') out.push({ kind: 'food', food: e.ref.food })
    }
    return out.slice(0, 30)
  }, [term, recipes, foods, noRecipes, notes, foodLog])

  useEffect(() => {
    ctrl.current?.abort()
    setRemote([])
    if (term.length < 3) { setLoading(false); return }
    const c = new AbortController()
    ctrl.current = c
    setLoading(true)
    const t = setTimeout(() => {
      offSearch(term, c.signal)
        .then((r) => {
          setRemote(r); setOffline(false)
          // then the missing values; products that really have none move to the end
          offFillValues(r, c.signal).then((f) => { if (!c.signal.aborted) setRemote(f) }).catch(() => { /* keep the plain list */ })
        })
        .catch((e) => { if ((e as Error).name !== 'AbortError') setOffline(true) })
        .finally(() => { if (!c.signal.aborted) setLoading(false) })
    }, 450)
    return () => { clearTimeout(t); c.abort() }
  }, [term])

  const openProduct = async (code: string, fallbackName?: string) => {
    const known = foods.find((f) => f.barcode === code)
    if (known) { setChosen({ kind: 'food', food: withOverride(known) }); return }
    setBusy(code)
    try {
      const f = await offProduct(code)
      if (f) setChosen({ kind: 'food', food: withOverride(f) })
      else setMissing({ code, name: fallbackName })
    } catch {
      setOffline(true)
    } finally {
      setBusy(null)
    }
  }

  const list = term ? local : recents
  return createPortal(
    <div className="fullsheet">
      <div className="fullsheet-head">
        <button className="icon-btn" onClick={onClose} aria-label={tr('Schließen', 'Close')}><Icon.back /></button>
        <div className="grow" style={{ fontWeight: 700, fontSize: 18 }}>{title}</div>
        <button className={'btn btn-ghost btn-sm nut-fav-btn' + (view === 'favs' ? ' on' : '')} onClick={() => { haptic(); setQ(''); setView(view === 'favs' ? 'recent' : 'favs') }} aria-label={tr('Favoriten', 'Favourites')}>
          <HeartIcon on={view === 'favs'} />
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setCustom({})}>{tr('Eigenes', 'Custom')}</button>
      </div>
      <div className="nut-search">
        <input className="input" placeholder={tr('Lebensmittel, Marke oder Rezept', 'Food, brand or recipe')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <Tap className="nut-scan" onClick={() => setScan(true)} aria-label={tr('Barcode scannen', 'Scan barcode')}><ScanIcon /></Tap>
      </div>

      <div className="fullsheet-body">
        {!term && !noRecipes && view !== 'favs' && (
          <div className="segmented" style={{ marginBottom: 10 }}>
            <button className={view === 'recent' ? 'on' : ''} onClick={() => setView('recent')}>{tr('Zuletzt', 'Recent')}</button>
            <button className={view === 'recipes' ? 'on' : ''} onClick={() => setView('recipes')}>{tr('Rezepte', 'Recipes')}</button>
          </div>
        )}
        {!term && view === 'favs' ? (
          <>
            <div className="eyebrow" style={{ margin: '2px 2px 6px' }}>{tr('Favoriten', 'Favourites')}</div>
            {favs.length === 0 && <div className="faint" style={{ fontSize: 13, padding: '6px 2px' }}>{tr('Noch keine Favoriten – tipp bei einem Lebensmittel auf das Herz.', 'No favourites yet – tap the heart on a food.')}</div>}
            {favs.map((p) => <FavRow key={pickId(p)} p={p} fav onFav={() => toggleFav(p)} onClick={() => setChosen(p)} />)}
          </>
        ) : !term && view === 'recipes' && !noRecipes ? (
          <>
            {recipes.map((r) => (
              <div key={r.id} className="nut-pick-row">
                <PickRow p={{ kind: 'recipe', recipe: r }} onClick={() => setChosen({ kind: 'recipe', recipe: r })} />
                <button className="nut-edit" onClick={() => setEditRecipe(r)} aria-label={tr(`${r.name} bearbeiten`, `Edit ${r.name}`)}>{tr('Bearbeiten', 'Edit')}</button>
              </div>
            ))}
            <button className="btn btn-ghost btn-block" style={{ marginTop: 12 }} onClick={() => setEditRecipe('new')}><Icon.plus /> {tr('Neues Rezept', 'New recipe')}</button>
          </>
        ) : (
          <>
            {!term && recents.length === 0 && <div className="faint" style={{ fontSize: 13, padding: '6px 2px' }}>{tr('Noch nichts eingetragen – suchen oder Barcode scannen.', 'Nothing logged yet – search or scan a barcode.')}</div>}
            {list.map((p) => (
              <FavRow key={pickId(p)} p={p} fav={favIds.has(pickId(p))} onFav={() => toggleFav(p)} onClick={() => setChosen(p)} />
            ))}
          </>
        )}
        {term && onPickMany && term.length >= 3 && (
          <button className="ai-row" onClick={() => requireAi() && setAiText(q.trim())}>
            <span className="ai-spark" aria-hidden="true">✦</span>
            <div className="grow">
              <div className="nut-entry-name">{tr('Mit KI eintragen', 'Log with AI')}</div>
              <div className="faint" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tr(`„${q.trim()}“ – auch mehrere Sachen mit Mengen`, `“${q.trim()}” – several items with amounts too`)}</div>
            </div>
          </button>
        )}
        {term && (
          <>
            <div className="eyebrow" style={{ margin: '14px 2px 6px', display: 'flex', justifyContent: 'space-between' }}>
              <span>{tr('Produkte', 'Products')}</span><span className="faint">{loading ? tr('suche…', 'searching…') : offline ? 'offline' : 'Open Food Facts'}</span>
            </div>
            {term.length < 3 && <div className="faint" style={{ fontSize: 13, padding: '4px 2px' }}>{tr('Ab 3 Buchstaben wird online gesucht', 'Online search starts at 3 letters')}</div>}
            {/* products without nutrition values come last, marked so they don't have to be opened to find out */}
            {remote.map((h) => (
              <button key={h.code} className={'nut-pick' + (h.none ? ' nut-pick-novalues' : '')} onClick={() => openProduct(h.code, h.name)} disabled={busy === h.code}>
                <div className="grow">
                  <div className="nut-entry-name">{h.name}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{h.brand ?? ''}{h.none && <span className="nut-novalues">{h.brand ? ' · ' : ''}{tr('keine Nährwerte', 'no nutrition values')}</span>}</div>
                </div>
                <span className="faint num" style={{ fontSize: 13 }}>{busy === h.code ? '…' : (overrideKcal(h.code) ?? h.kcal) != null ? `${Math.round(overrideKcal(h.code) ?? h.kcal!)} kcal` : ''}</span>
              </button>
            ))}
            {!loading && !offline && term.length >= 3 && remote.length === 0 && <div className="faint" style={{ fontSize: 13, padding: '4px 2px' }}>{tr('Nichts gefunden – „Eigenes“ anlegen.', 'Nothing found – create a “Custom” one.')}</div>}
          </>
        )}
      </div>

      {scan && (
        <Scanner
          // opened via the scan button: cancelling goes straight back
          onClose={() => { setScan(false); if (startScan && !missing) onClose() }}
          onCode={(code) => { setScan(false); openProduct(code) }}
        />
      )}
      {busy && !scan && <div className="nut-loading">{tr('Produkt wird geladen…', 'Loading product…')}</div>}
      {aiText && onPickMany && (
        <FoodPhoto
          source={{ kind: 'text', text: aiText, known }}
          onClose={() => setAiText(null)}
          onAdd={(items) => { setAiText(null); onPickMany(items) }}
        />
      )}
      {editRecipe && <RecipeEditor recipe={editRecipe === 'new' ? null : editRecipe} onClose={() => setEditRecipe(null)} />}
      {missing && (
        <Sheet onClose={() => setMissing(null)}>
          <h3>{tr('Produkt nicht gefunden', 'Product not found')}</h3>
          <p className="faint" style={{ fontSize: 13 }}>
            {missing.name ? tr(`„${missing.name}“ hat noch keine Nährwerte.`, `“${missing.name}” has no nutrition values yet.`) : tr('Diesen Barcode kennt die Datenbank noch nicht.', 'The database does not know this barcode yet.')} {tr('Leg es einmal an – danach erkennt VIS es beim Scannen automatisch.', 'Create it once – after that VIS recognises it when scanning.')}
          </p>
          <p className="faint num" style={{ fontSize: 12, marginTop: 4 }}>Barcode {missing.code}</p>
          <Tap className="btn btn-chrome btn-block" style={{ marginTop: 16 }} onClick={() => { setCustom({ barcode: missing.code, name: missing.name }); setMissing(null) }}>{tr('Produkt anlegen', 'Create product')}</Tap>
          <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => { setMissing(null); setScan(true) }}>{tr('Erneut scannen', 'Scan again')}</button>
        </Sheet>
      )}
      {chosen && (
        <AmountSheet
          pick={chosen} onClose={() => setChosen(null)} onDone={(g, portion) => { onPick(chosen, g, portion); setChosen(null) }}
          noteId={pickId(chosen)}
          {...lastAmount(chosen)}
          extra={chosen.kind === 'food' && chosen.food.source !== 'basic' ? (
            <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => setEditing(chosen.food)}>{tr('Nährwerte bearbeiten', 'Edit nutrition values')}</button>
          ) : undefined}
        />
      )}
      {editing && (
        <CustomFoodSheet
          initial={{}} edit={editing}
          onClose={() => setEditing(null)}
          onSave={(f) => { updateFood(f, editing); setEditing(null); setChosen({ kind: 'food', food: f }) }}
        />
      )}
      {custom && (
        <CustomFoodSheet
          initial={custom}
          onClose={() => setCustom(null)}
          onSave={(f) => { saveFood(f); setCustom(null); setChosen({ kind: 'food', food: f }) }}
        />
      )}
    </div>,
    document.body,
  )
}

function PickRow({ p, onClick }: { p: Pick; onClick: () => void }) {
  const f = pickFood(p)
  const sub = p.kind === 'recipe' ? tr('Rezept', 'Recipe') : p.food.brand ?? (p.food.source === 'basic' ? tr('Grundnahrungsmittel', 'Basic food') : p.food.source === 'custom' ? tr('Eigenes', 'Custom') : '')
  return (
    <button className="nut-pick" onClick={onClick}>
      <div className="grow">
        <div className="nut-entry-name">{pickName(p)}</div>
        <div className="faint" style={{ fontSize: 12 }}>{sub}</div>
      </div>
      {/* recipes: the whole dish (per 100 g alone looked far too low); foods: per 100 g */}
      {p.kind === 'recipe' ? (
        <span className="faint num" style={{ fontSize: 13, textAlign: 'right' }}>
          {fmtInt(recipeTotal(p.recipe).kcal)} kcal
          <span style={{ display: 'block', fontSize: 11 }}>{Math.round(f.kcal)} / 100 g</span>
        </span>
      ) : (
        <span className="faint num" style={{ fontSize: 13 }}>{Math.round(f.kcal)} kcal</span>
      )}
    </button>
  )
}

/** a pick row with a heart to (un)mark it as favourite */
function FavRow({ p, fav, onFav, onClick }: { p: Pick; fav: boolean; onFav: () => void; onClick: () => void }) {
  return (
    <div className="nut-pick-row">
      <PickRow p={p} onClick={onClick} />
      <button className={'nut-heart' + (fav ? ' on' : '')} onClick={onFav} aria-label={fav ? tr('Aus Favoriten entfernen', 'Remove from favourites') : tr('Zu Favoriten', 'Add to favourites')}>
        <HeartIcon on={fav} />
      </button>
    </div>
  )
}

function HeartIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z" />
    </svg>
  )
}

/** days in a row with at least 70 % of the day's calorie target eaten */
export function eatStreak(foodLog: FoodEntry[], phases: Phase[]) {
  const kcal = new Map<string, number>()
  for (const e of foodLog) kcal.set(e.date, (kcal.get(e.date) ?? 0) + e.kcal)
  const reached = (d: string) => {
    const target = kcalTarget(phases, d)
    return !!target && (kcal.get(d) ?? 0) >= target * 0.7
  }
  const t = today()
  const todayDone = reached(t)
  // today still open: the streak up to yesterday stays alive until the day is over
  let d = todayDone ? t : addDays(t, -1)
  let n = 0
  while (reached(d) && n < 3650) { n++; d = addDays(d, -1) }
  return { days: n, todayDone, hasTarget: !!kcalTarget(phases, t) }
}

function EatStreak() {
  const { foodLog, phases } = useStore()
  const s = useMemo(() => eatStreak(foodLog, phases), [foodLog, phases])
  const [info, setInfo] = useState(false)
  if (!s.hasTarget) return null
  return (
    <>
      <button className={'nut-streak' + (s.todayDone ? ' on' : '') + (s.days === 0 ? ' zero' : '')} onClick={() => { haptic(); setInfo(true) }}
        aria-label={tr(`Ess-Streak: ${s.days} Tage`, `Eating streak: ${s.days} days`)}>
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2.5c.6 3.2 4.8 5.6 4.8 10.4A4.8 4.8 0 0 1 12 17.7a4.8 4.8 0 0 1-4.8-4.8c0-2 1-3.4 2.1-4.6.2 1.5.9 2.6 2 3.1C10.8 8.7 11.2 5.3 12 2.5Z" fill="currentColor" /><path d="M8 20.5h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        <b className="num">{s.days}</b>
      </button>
      {info && (
        <Sheet onClose={() => setInfo(false)}>
          <h3>{tr('Ess-Streak', 'Eating streak')}</h3>
          <div className="nut-streak-big num">{s.days}<span>{s.days === 1 ? tr('Tag', 'day') : tr('Tage', 'days')}</span></div>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {tr('Ein Tag zählt, wenn du mindestens 70 % deines Kalorienziels einträgst. Verpasst du einen Tag, beginnt der Streak von vorn.', 'A day counts when you log at least 70 % of your calorie target. Miss a day and the streak starts over.')}
          </p>
          <div className="hint" style={{ marginTop: 12 }}>
            <span>{s.todayDone ? tr('Heute schon geschafft ✓', 'Done for today ✓') : tr('Heute noch offen – trag bis Mitternacht 70 % deines Ziels ein, dann geht der Streak weiter.', 'Still open today – log 70 % of your target before midnight to keep it going.')}</span>
          </div>
        </Sheet>
      )}
    </>
  )
}

/** one diary entry */
function EntryRow({ e, onOpen }: { e: FoodEntry; onOpen: () => void }) {
  return (
    <button className="nut-entry" onClick={onOpen}>
      <div className="grow">
        <div className="nut-entry-name">{e.name}</div>
        <div className="faint num" style={{ fontSize: 12 }}>{e.at.slice(11, 16)} · {fmtG(e.grams)} g · {fmtG(e.p)} {tr('E', 'P')} · {fmtG(e.c)} {tr('K', 'C')} · {fmtG(e.f)} F</div>
      </div>
      <span className="num">{fmtInt(e.kcal)}</span>
    </button>
  )
}

/** Amount in grams with quick chips; live macros. */
// portions on the flat wheel: halves up to 5, then whole ones
const PORTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10]

function AmountSheet({ pick, onClose, onDone, initial, initialCount = 1, action = tr('Hinzufügen', 'Add'), extra, heart, noteId }: {
  pick: Pick
  onClose: () => void
  /** total grams; `portion` when more or less than one portion was chosen */
  onDone: (grams: number, portion?: { g: number; n: number }) => void
  /** grams of one portion */
  initial?: number
  initialCount?: number
  action?: string
  extra?: React.ReactNode
  /** shown next to the title, e.g. the favourite heart */
  heart?: React.ReactNode
  /** food / recipe id the own note belongs to */
  noteId?: string | null
}) {
  const food = pickFood(pick)
  const chips = useMemo(() => {
    const c: { label: string; g: number }[] = []
    if (pick.kind === 'recipe') {
      const w = recipeWeight(pick.recipe)
      c.push({ label: '¼', g: w / 4 }, { label: '⅓', g: w / 3 }, { label: '½', g: w / 2 }, { label: tr('Ganz', 'Whole'), g: w })
    } else {
      if (food.serving) c.push({ label: food.serving.label, g: food.serving.g })
      for (const g of [50, 100, 150, 200, 250]) c.push({ label: `${g} g`, g })
    }
    return c
  }, [pick, food])
  const [text, setText] = useState(() => String(Math.round(initial ?? (food.serving?.g ?? (pick.kind === 'recipe' ? recipeWeight(pick.recipe) / 2 : 100)))))
  const [n, setN] = useState(initialCount)
  const one = Math.max(0, Number(text.replace(',', '.')) || 0)
  const grams = Math.round(one * n * 10) / 10
  const m: Macros = forGrams(food, grams)
  const fmtN = (x: number) => (x === 0.5 ? '½' : Number.isInteger(x) ? String(x) : `${Math.floor(x)}½`)
  return (
    <Sheet onClose={onClose}>
      <div className="nut-amount-head">
        <h3 style={{ paddingRight: 8 }}>{pickName(pick)}</h3>
        {heart}
      </div>
      {noteId && <FoodNote id={noteId} />}
      <p className="faint num" style={{ fontSize: 13 }}>
        {tr('pro 100 g', 'per 100 g')}: {Math.round(food.kcal)} kcal · {fmtG(food.p)} {tr('E', 'P')} · {fmtG(food.c)} {tr('K', 'C')} · {fmtG(food.f)} F
      </p>
      {/* how many: × portions on a flat wheel, the chips and the field are one portion */}
      <div className="nut-portion-cap">
        <span>{tr('Anzahl', 'Portions')}</span>
        <b className="num">{n === 1 ? tr('1 Portion', '1 portion') : `${fmtN(n)} × ${fmtG(one)} g = ${fmtG(grams)} g`}</b>
      </div>
      <HWheel values={PORTIONS} value={n} onChange={setN} format={(x) => `${fmtN(x)}×`} />
      <div className="chips" style={{ margin: '8px -18px 0', padding: '2px 18px 4px' }}>
        {chips.map((c) => <button key={c.label} className={'chip' + (Math.round(c.g) === Math.round(one) ? ' on' : '')} onClick={() => setText(String(Math.round(c.g)))}>{c.label}</button>)}
      </div>
      <div className="nut-amount">
        <input className="field num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} />
        <span className="muted">g</span>
      </div>
      <div className="grid-3 nut-sum">
        <div><b className="num">{fmtInt(m.kcal)}</b><span>kcal</span></div>
        <div><b className="num">{fmtG(m.p)}</b><span>{tr('Eiweiß', 'Protein')}</span></div>
        <div><b className="num">{fmtG(m.c)} / {fmtG(m.f)}</b><span>{tr('KH / Fett', 'Carbs / fat')}</span></div>
      </div>
      {extra}
      <Tap className="btn btn-chrome btn-block" style={{ marginTop: 14 }} onClick={() => grams > 0 && onDone(grams, n !== 1 ? { g: one, n } : undefined)}>{action}</Tap>
    </Sheet>
  )
}

/**
 * The user's own note on a food or recipe (only on this account), e.g. "Toast" on
 * an American sandwich bread: the search and the AI then find it by that word.
 */
function FoodNote({ id }: { id: string }) {
  const store = useStore()
  const saved = store.settings.foodNotes?.[id] ?? ''
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(saved)
  const save = () => {
    const v = text.trim().slice(0, 120)
    const notes = { ...(store.settings.foodNotes ?? {}) }
    if (v) notes[id] = v
    else delete notes[id]
    if (v !== saved) store.saveSettings({ ...store.settings, foodNotes: notes })
    setOpen(false)
  }
  if (open) {
    return (
      <form className="nut-note-edit" onSubmit={(e) => { e.preventDefault(); save() }}>
        <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} onBlur={save} maxLength={120}
          placeholder={tr('z. B. Toast – so findet dich die Suche und die KI', 'e.g. toast – how search and AI find it')} />
      </form>
    )
  }
  return (
    <button className={'nut-note' + (saved ? ' has' : '')} onClick={() => { setText(saved); setOpen(true) }}>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></svg>
      {saved ? saved : tr('Notiz hinzufügen', 'Add a note')}
    </button>
  )
}

/**
 * Saves an edited food and puts the new values everywhere it was used: every
 * diary entry with it is recalculated, recipes get the new values too.
 */
const toastCorrection = () => window.dispatchEvent(new CustomEvent('vis-toast', { detail: tr('Geändert – und zur Prüfung für alle gesendet', 'Changed – and sent for review for everyone') }))

function useUpdateFood() {
  const store = useStore()
  return (f: Food, before?: Food) => {
    store.saveFood(f)
    // a database product: the change applies here at once and goes to the owner as a request
    if (before) sendCorrection(before, f).then((sent) => sent && toastCorrection()).catch(() => {})
    for (const e of store.foodLog) {
      if (e.ref.kind === 'food' && e.ref.food.id === f.id) store.saveFoodEntry({ ...e, name: f.name, ref: { kind: 'food', food: f }, ...forGrams(f, e.grams) })
    }
    for (const r of store.recipes) {
      if (r.items.some((it) => it.food.id === f.id)) store.saveRecipe({ ...r, items: r.items.map((it) => (it.food.id === f.id ? { ...it, food: f } : it)) })
    }
  }
}

function EntrySheet({ entry, onClose }: { entry: FoodEntry; onClose: () => void }) {
  const store = useStore()
  const updateFood = useUpdateFood()
  const [editFood, setEditFood] = useState<Food | null>(null)
  const rec = entry.ref.kind === 'recipe' ? store.recipes.find((r) => r.id === (entry.ref as { id: string }).id) : null
  const pick: Pick = entry.ref.kind === 'food'
    ? { kind: 'food', food: entry.ref.food }
    : rec ? { kind: 'recipe', recipe: rec }
      // recipe was deleted: keep its values as a plain food
      : { kind: 'food', food: { id: 'x', name: entry.name, source: 'custom', ...forGrams(entry, 100 * 100 / entry.grams / 100) } }
  // heart: mark what was eaten as a favourite right from the diary
  const favId = pick.kind === 'recipe' ? pick.recipe.id : pick.food.id !== 'x' ? pick.food.id : null
  const fav = !!favId && (store.settings.favFoods ?? []).includes(favId)
  const toggleFav = () => {
    if (!favId) return
    haptic()
    // products from the online search are kept locally so the favourite works offline
    if (!fav && pick.kind === 'food' && pick.food.source === 'off' && !store.foods.some((f) => f.id === favId)) store.saveFood(pick.food)
    const list = store.settings.favFoods ?? []
    store.saveSettings({ ...store.settings, favFoods: fav ? list.filter((x) => x !== favId) : [...list, favId] })
  }
  return (
    <AmountSheet
      pick={pick}
      noteId={favId}
      heart={favId ? (
        <button className={'nut-heart' + (fav ? ' on' : '')} onClick={toggleFav} aria-label={fav ? tr('Aus Favoriten entfernen', 'Remove from favourites') : tr('Zu Favoriten', 'Add to favourites')}>
          <HeartIcon on={fav} />
        </button>
      ) : undefined}
      initial={entry.portion?.g ?? entry.grams}
      initialCount={entry.portion?.n ?? 1}
      action={tr('Speichern', 'Save')}
      onClose={onClose}
      onDone={(g, portion) => {
        const { portion: _old, ...rest } = entry // eslint-disable-line @typescript-eslint/no-unused-vars
        store.saveFoodEntry({ ...rest, grams: g, ...forGrams(pickFood(pick), g), ...(portion ? { portion } : {}) })
        onClose()
      }}
      extra={
        <>
          {entry.ref.kind === 'food' && (
            <button className="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => setEditFood(store.foods.find((x) => x.id === (entry.ref as { food: Food }).food.id) ?? (entry.ref as { food: Food }).food)}>
              {tr('Nährwerte bearbeiten', 'Edit nutrition values')}
            </button>
          )}
          <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} onClick={() => { store.deleteFoodEntry(entry.id); onClose() }}>{tr('Eintrag löschen', 'Delete entry')}</button>
          {editFood && (
            <CustomFoodSheet
              initial={{}} edit={editFood}
              onClose={() => setEditFood(null)}
              onSave={(f) => { updateFood(f, editFood); setEditFood(null); onClose() }}
            />
          )}
        </>
      }
    />
  )
}

function CustomFoodSheet({ initial, edit, onClose, onSave }: {
  initial: { barcode?: string; name?: string }
  /** an existing food: the sheet edits it (same id) instead of creating a new one */
  edit?: Food
  onClose: () => void
  onSave: (f: Food) => void
}) {
  const fmt = (x: number | undefined) => (x == null ? '' : decStr(Math.round(x * 10) / 10))
  const [v, setV] = useState(edit
    ? { name: edit.name, brand: edit.brand ?? '', kcal: String(Math.round(edit.kcal)), p: fmt(edit.p), c: fmt(edit.c), f: fmt(edit.f), serving: edit.serving ? String(Math.round(edit.serving.g)) : '' }
    : { name: initial.name ?? '', brand: '', kcal: '', p: '', c: '', f: '', serving: '' })
  // front of the pack: the AI reads product name and brand
  const front = useRef<HTMLInputElement>(null)
  const [readingFront, setReadingFront] = useState(false)
  const readFront = async (file: File) => {
    setReadingFront(true)
    setLabelMsg(null)
    try {
      const d = await foodAi({ mode: 'front', image: await shrink(file, 1024), mediaType: 'image/jpeg' })
      if (!d?.found || !(d.name || d.brand)) throw new Error(tr('Kein Produkt erkannt – die Vorderseite gerade und nah fotografieren.', 'No product recognised – photograph the front straight and close.'))
      setV((cur) => ({ ...cur, name: d.name || cur.name, brand: d.brand || cur.brand }))
      setLabelMsg(tr('Name und Marke eingetragen – jetzt noch die Nährwerttabelle.', 'Name and brand filled in – now the nutrition label.'))
      haptic(true)
    } catch (e) {
      setLabelMsg((e as Error).message)
    } finally {
      setReadingFront(false)
    }
  }
  const num = (s: string) => Math.max(0, Number(s.replace(',', '.')) || 0)
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value })
  const ok = v.name.trim() && num(v.kcal) > 0
  const label = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [labelMsg, setLabelMsg] = useState<string | null>(null)
  const readLabel = async (file: File) => {
    setReading(true)
    setLabelMsg(null)
    try {
      // labels have small print: a bit more resolution than meal photos
      const d = await foodAi({ mode: 'label', image: await shrink(file, 1400), mediaType: 'image/jpeg' })
      if (!d?.found) throw new Error(tr('Keine Nährwerttabelle erkannt – näher ran und gerade fotografieren.', 'No nutrition label recognised – get closer and shoot it straight.'))
      const n = (x: unknown) => (Number(x) > 0 ? decStr(Math.round(Number(x) * 10) / 10) : '0')
      setV((cur) => ({
        name: cur.name || d.name || '', brand: cur.brand || d.brand || '',
        kcal: String(Math.round(Number(d.kcal) || 0)), p: n(d.protein), c: n(d.carbs), f: n(d.fat),
        serving: Number(d.serving) > 0 ? String(Math.round(Number(d.serving))) : cur.serving,
      }))
      setLabelMsg(tr('Abgelesen – kurz mit der Packung vergleichen.', 'Read – quickly compare with the pack.'))
      haptic(true)
    } catch (e) {
      setLabelMsg((e as Error).message)
    } finally {
      setReading(false)
    }
  }
  return (
    <Sheet onClose={onClose}>
      <h3>{edit ? tr('Lebensmittel bearbeiten', 'Edit food') : tr('Eigenes Lebensmittel', 'Custom food')}</h3>
      {initial.barcode && <p className="faint" style={{ fontSize: 13 }}>{tr(`Barcode ${initial.barcode} ist noch unbekannt – einmal anlegen, dann erkennt VIS ihn.`, `Barcode ${initial.barcode} is still unknown – create it once, then VIS recognises it.`)}</p>}
      <div className="grid-2" style={{ marginTop: 10 }}>
        <Tap className="btn btn-ghost btn-block nut-photo-btn" onClick={() => !readingFront && requireAi() && front.current?.click()}>
          <CameraIcon /> {readingFront ? tr('Wird gelesen…', 'Reading…') : tr('Vorderseite', 'Front')}
        </Tap>
        <Tap className="btn btn-ghost btn-block nut-photo-btn" onClick={() => !reading && requireAi() && label.current?.click()}>
          <CameraIcon /> {reading ? tr('Wird abgelesen…', 'Reading…') : tr('Nährwerte', 'Nutrition')}
        </Tap>
      </div>
      <div className="faint" style={{ fontSize: 12, marginTop: 6, textAlign: 'center' }}>{tr('Vorderseite = Name und Marke · Nährwerte = die Tabelle', 'Front = name and brand · Nutrition = the table')}</div>
      <input ref={front} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) readFront(f); e.target.value = '' }} />
      <input ref={label} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) readLabel(f); e.target.value = '' }} />
      {labelMsg && <div className="hint"><span>{labelMsg}</span></div>}
      <label className="lbl">Name</label>
      <input className="input" value={v.name} onChange={set('name')} placeholder={tr('z. B. Proteinriegel', 'e.g. protein bar')} />
      <label className="lbl">{tr('Marke (optional)', 'Brand (optional)')}</label>
      <input className="input" value={v.brand} onChange={set('brand')} />
      <label className="lbl">{tr('Pro 100 g', 'Per 100 g')}</label>
      <div className="grid-2">
        <input className="input num" inputMode="decimal" placeholder="kcal" value={v.kcal} onChange={set('kcal')} />
        <input className="input num" inputMode="decimal" placeholder={tr('Eiweiß g', 'Protein g')} value={v.p} onChange={set('p')} />
        <input className="input num" inputMode="decimal" placeholder={tr('Kohlenhydrate g', 'Carbs g')} value={v.c} onChange={set('c')} />
        <input className="input num" inputMode="decimal" placeholder={tr('Fett g', 'Fat g')} value={v.f} onChange={set('f')} />
      </div>
      <label className="lbl">{tr('Portion in g (optional)', 'Serving in g (optional)')}</label>
      <input className="input num" inputMode="decimal" value={v.serving} onChange={set('serving')} placeholder={tr('z. B. 45', 'e.g. 45')} />
      <button
        className="btn btn-chrome btn-block" style={{ marginTop: 16 }} disabled={!ok}
        onClick={() => onSave({
          id: edit?.id ?? 'c-' + uid(), name: v.name.trim(), brand: v.brand.trim() || undefined,
          kcal: num(v.kcal), p: num(v.p), c: num(v.c), f: num(v.f), source: 'custom',
          ...(edit?.barcode || initial.barcode ? { barcode: edit?.barcode ?? initial.barcode } : {}),
          ...(num(v.serving) > 0 ? { serving: { label: tr('1 Portion', '1 serving'), g: num(v.serving) } } : {}),
        })}
      >{tr('Speichern', 'Save')}</button>
    </Sheet>
  )
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M8 8v8M11 8v8M14 8v8M17 8v8" strokeWidth="1.4" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  )
}
