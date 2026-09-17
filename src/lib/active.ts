import { createContext, useContext } from 'react'

export const ActiveCtx = createContext(true)

/** True while this utility is the one on screen. Opened utilities stay mounted in the background, so pause expensive work when this is false. */
export const useIsActive = () => useContext(ActiveCtx)
