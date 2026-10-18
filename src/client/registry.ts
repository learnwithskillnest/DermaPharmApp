import { SearchBox } from './islands/SearchBox.tsx';
import { AddToCart } from './islands/AddToCart.tsx';
import { ProductGallery } from './islands/ProductGallery.tsx';
import { RazorpayCheckout } from './islands/RazorpayCheckout.tsx';

/** Components that are server-rendered AND hydrated in the browser. */
export const islands = { SearchBox, AddToCart, ProductGallery, RazorpayCheckout } as const;
export type IslandName = keyof typeof islands;
