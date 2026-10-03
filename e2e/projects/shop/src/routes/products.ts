import { db } from "../db";

/** GET /products: everything in the shop. */
export function listProducts(): Response {
  return Response.json(db.products());
}

/** GET /products/:id */
export function getProduct(id: string): Response {
  const product = db.product(id);
  return product ? Response.json(product) : new Response("not found", { status: 404 });
}
