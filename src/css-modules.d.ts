declare module '*.module.css' {
  interface ClassMap { [key: string]: string }
  const classes: ClassMap
  export default classes
}
