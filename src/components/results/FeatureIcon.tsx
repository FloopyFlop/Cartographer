import { Bike, Armchair, Accessibility, Footprints, GlassWater, DoorOpen, MapPin } from 'lucide-react'
export function FeatureIcon({ type, size = 18 }: { type: string; size?: number }) {
  const Icon = /bicy|bike/.test(type) ? Bike : /bench/.test(type) ? Armchair : /ramp|curb|wheel/.test(type) ? Accessibility : /crosswalk/.test(type) ? Footprints : /fountain|water/.test(type) ? GlassWater : /entrance/.test(type) ? DoorOpen : MapPin
  return <Icon size={size} strokeWidth={1.7}/>
}
