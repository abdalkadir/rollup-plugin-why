import { widget } from '@scope/widget';
import { deep } from 'nested-host';
import 'effectful-true';
import 'effectful-list';
import './local-effect.js';

console.log(widget(), deep());
