import { businessGet, businessSave } from "../_business";
export async function GET(request:Request){return businessGet(request,"invoiceDrafts");}
export async function POST(request:Request){return businessSave(request,"invoiceDrafts",true);}
export async function PUT(request:Request){return businessSave(request,"invoiceDrafts",false);}
