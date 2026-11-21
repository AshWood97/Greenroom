import {useEffect,useState} from 'react';
import type {RenderLayout} from '@/lib/render/types';
export function collectUrls(layout:RenderLayout){return new Set([...layout.series,...Object.values(layout.sequences).flatMap(value=>value||[])].map(({element})=>element.url));}
/** Native Revideo nodes load their own images and video metadata. */
export function useAssetPrefetch(layout:RenderLayout){const [ready,setReady]=useState(false);useEffect(()=>{setReady(true);},[layout]);return ready;}
